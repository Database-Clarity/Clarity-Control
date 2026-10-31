import {
  sameCell,
  normaliseRuns,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumRow,
  type CompendiumSheet,
} from './types.js';
import { compendiumTabs, isTrackedCompendiumTab } from './config.js';
import { selectCompendiumCells } from './cells.js';

export function normaliseCompendiumName(name: string): string {
  return name
    .replace(/(?:\s*[(\u005b][^()[\]]*[)\u005d])+\s*$/gu, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function grams(text: string): Set<string> {
  const value = normaliseCompendiumName(text);
  return new Set(
    value.length < 3
      ? [value]
      : Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3)),
  );
}
export function compendiumSimilarity(left: string, right: string): number {
  if (!left.trim() || !right.trim()) return left === right ? 1 : 0;
  const a = grams(left);
  const b = grams(right);
  const common = [...a].filter((gram) => b.has(gram)).length;
  return (2 * common) / (a.size + b.size);
}
export interface CompendiumMatch {
  tab: CompendiumSheet;
  row: CompendiumRow;
  parts?: string[];
  cells?: CompendiumLink['cells'];
}
export interface CompendiumCandidate extends CompendiumMatch {
  similarity: number;
}
export type CompendiumResolution =
  | ({ status: 'ok' | 'changed' | 'moved'; changed: boolean } & CompendiumMatch)
  | { status: 'candidates'; candidates: CompendiumCandidate[] }
  | { status: 'missing' };

export function resolveCompendiumLink(
  link: CompendiumLink,
  data: CompendiumData,
): CompendiumResolution {
  const all: CompendiumMatch[] = data.tabs
    .filter((tab) => isTrackedCompendiumTab(tab.name))
    .flatMap((tab) => tab.rows.map((row) => ({ tab, row })));
  // An arbitrary human-picked anchor need not be one of the parsed named rows.
  if (link.cells) {
    for (const tab of data.tabs.filter((tab) => isTrackedCompendiumTab(tab.name))) {
      for (const entry of tab.grid ?? []) {
        if (
          normaliseCompendiumName(entry.cell.plain.trim()) !== normaliseCompendiumName(link.rowKey)
        )
          continue;
        if (
          !all.some(
            (match) =>
              match.tab === tab &&
              match.row.anchor?.row === entry.row &&
              match.row.anchor?.col === entry.col,
          )
        ) {
          all.push({
            tab,
            row: {
              name: entry.cell.plain.trim(),
              nameNorm: normaliseCompendiumName(entry.cell.plain.trim()),
              rowIndex: entry.row,
              anchor: { row: entry.row, col: entry.col },
              cell: entry.cell,
            },
          });
        }
      }
    }
  }
  let found = all.filter(({ tab, row }) => tab.gid === link.gid && row.name === link.rowKey);
  if (found.length && !link.cells)
    found = all.filter(
      ({ tab, row }) =>
        tab.gid === link.gid && row.nameNorm === normaliseCompendiumName(link.rowKey),
    );
  let moved = false;
  if (!found.length) {
    found = all.filter(({ row }) => row.nameNorm === normaliseCompendiumName(link.rowKey));
    moved = true;
  }
  if (found.length) {
    // A saved section disambiguates category collisions only. Sections within the
    // same category still contribute all of their legitimate multipart content.
    if (
      !link.cells &&
      link.section &&
      found.every(({ tab }) => tab.gid === link.gid) &&
      new Set(found.map(categoryOf).filter(Boolean)).size > 1
    ) {
      const category = compendiumTabs[link.gid]?.sectionCategories?.[link.section];
      if (category) found = found.filter((entry) => categoryOf(entry) === category);
    }
    if (link.cells && found.length > 1 && link.section) {
      const section = found.filter(({ row }) => row.section === link.section);
      if (section.length) found = section;
    }
    const match = link.cells
      ? found.length === 1
        ? found[0]
        : undefined
      : combineCompendiumMatches(found);
    if (!match)
      return {
        status: 'candidates',
        candidates: found.slice(0, 3).map((entry) => ({
          ...entry,
          similarity: compendiumSimilarity(link.snapshot.plain, entry.row.cell.plain),
        })),
      };
    if (link.cells) {
      const cell =
        match.row.anchor && selectCompendiumCells(match.tab, match.row.anchor, link.cells);
      // Do not fall back to configured cells or similarity when a human override breaks.
      if (!cell) return { status: 'missing' };
      match.row = { ...match.row, cell };
      match.cells = link.cells;
    }
    const changed =
      !sameCell(link.snapshot, match.row.cell) ||
      JSON.stringify(link.parts ?? []) !== JSON.stringify(match.parts ?? []);
    return {
      ...match,
      changed,
      status: moved || match.row.name !== link.rowKey ? 'moved' : changed ? 'changed' : 'ok',
    };
  }
  const candidates = all
    .map((match) => ({
      ...match,
      similarity: compendiumSimilarity(link.snapshot.plain, match.row.cell.plain),
    }))
    .filter((candidate) => candidate.similarity >= 0.6)
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.tab.gid.localeCompare(b.tab.gid) ||
        a.row.rowIndex - b.row.rowIndex,
    )
    .slice(0, 3);
  return candidates.length ? { status: 'candidates', candidates } : { status: 'missing' };
}
function categoryOf({ tab, row }: CompendiumMatch): string | undefined {
  return compendiumTabs[tab.gid]?.sectionCategories?.[row.section ?? ''];
}
// Combine only the same named thing in one tab; explicit category boundaries stay ambiguous.
export function combineCompendiumMatches(matches: CompendiumMatch[]): CompendiumMatch | undefined {
  if (!matches.length) return undefined;
  const sorted = [...matches].sort(
    (a, b) =>
      a.row.rowIndex - b.row.rowIndex || (a.row.anchor?.col ?? 0) - (b.row.anchor?.col ?? 0),
  );
  const first = sorted[0];
  const categories = new Set(
    sorted
      .map(({ tab, row }) => compendiumTabs[tab.gid]?.sectionCategories?.[row.section ?? ''])
      .filter(Boolean),
  );
  if (
    new Set(sorted.map(({ row }) => `${row.rowIndex}:${row.anchor?.col ?? 0}`)).size !==
      sorted.length ||
    categories.size > 1 ||
    sorted.some(({ tab, row }) => tab.gid !== first.tab.gid || row.nameNorm !== first.row.nameNorm)
  )
    return undefined;
  if (sorted.length === 1) return { ...first };
  const parts = sorted.map(({ tab, row }, index) => {
    const context = tab.grid?.find(
      (entry) =>
        entry.row === row.rowIndex &&
        entry.col !== row.anchor?.col &&
        entry.cell.plain.trim() &&
        entry.cell.plain !== row.cell.plain &&
        entry.cell.plain.trim() !== row.name,
    );
    const qualifier = /[([]([^()[\]]+)[)\]]\s*$/.exec(row.name)?.[1];
    return qualifier ?? context?.cell.plain.trim() ?? row.section ?? `Part ${index + 1}`;
  });
  return {
    tab: first.tab,
    parts,
    row: {
      ...first.row,
      cell: normaliseRuns(
        sorted.flatMap(({ row }, index) => [
          ...(index ? [{ text: '\n\n' }] : []),
          { text: `${parts[index]}\n`, bold: true },
          ...row.cell.runs,
        ]),
      ),
    },
  };
}
export function snapshotCompendium(
  match: CompendiumMatch,
  now = new Date().toISOString(),
): CompendiumLink {
  return {
    gid: match.tab.gid,
    rowKey: match.row.name,
    ...(match.row.section ? { section: match.row.section } : {}),
    ...(match.cells ? { cells: match.cells } : {}),
    ...(match.parts ? { parts: match.parts } : {}),
    snapshot: match.row.cell,
    snapshotAt: now,
  };
}
