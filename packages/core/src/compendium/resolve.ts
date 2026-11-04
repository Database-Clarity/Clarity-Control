import {
  sameCell,
  normaliseRuns,
  withBackground,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumRow,
  type CompendiumSheet,
  type CompendiumGridCell,
} from './types.js';
import { compendiumTabId, compendiumTabs, isTrackedCompendiumTab } from './config.js';
import { setBonusCell } from './setBonus.js';
import { selectCompendiumCells } from './cells.js';

// Matching compares the same source descriptions with many tooltips. Cache only
// pure text transforms, keyed by the complete text, so refreshed or edited inputs
// cannot reuse an earlier source's meaning. Both memory and entry count are bounded.
const normalized = new Map<string, string>();
let normalizedCharacters = 0;
const gramSets = new Map<string, Set<string>>();
let cachedGrams = 0;
let gramCharacters = 0;

export function normaliseCompendiumName(name: string): string {
  const cached = normalized.get(name);
  if (cached !== undefined) return cached;
  const value = name
    .replace(/(?:\s*[(\u005b][^()[\]]*[)\u005d])+\s*$/gu, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const characters = name.length + value.length;
  if (characters <= 4_000_000) {
    while (normalized.size >= 8192 || normalizedCharacters + characters > 4_000_000) {
      const [key, old] = normalized.entries().next().value!;
      normalized.delete(key);
      normalizedCharacters -= key.length + old.length;
    }
    normalized.set(name, value);
    normalizedCharacters += characters;
  }
  return value;
}
function grams(text: string): Set<string> {
  const cached = gramSets.get(text);
  if (cached) return cached;
  const value = normaliseCompendiumName(text);
  const result = new Set(
    value.length < 3
      ? [value]
      : Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3)),
  );
  if (result.size <= 500_000 && text.length <= 4_000_000) {
    while (
      gramSets.size >= 4096 ||
      cachedGrams + result.size > 500_000 ||
      gramCharacters + text.length > 4_000_000
    ) {
      const [key, old] = gramSets.entries().next().value!;
      gramSets.delete(key);
      cachedGrams -= old.size;
      gramCharacters -= key.length;
    }
    gramSets.set(text, result);
    cachedGrams += result.size;
    gramCharacters += text.length;
  }
  return result;
}
/** A positive minimum may return zero only for scores that cannot reach that minimum. */
export function compendiumSimilarity(left: string, right: string, minimum = 0): number {
  if (!left.trim() || !right.trim()) return left === right ? 1 : 0;
  const a = grams(left);
  const b = grams(right);
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if ((2 * smaller.size) / (a.size + b.size) < minimum) return 0;
  let common = 0;
  for (const gram of smaller) if (larger.has(gram)) common++;
  return (2 * common) / (a.size + b.size);
}
export interface CompendiumMatch {
  tab: CompendiumSheet;
  row: CompendiumRow;
  parts?: string[];
  cells?: CompendiumLink['cells'];
  setBonusPieces?: 2 | 4;
}
export interface CompendiumCandidate extends CompendiumMatch {
  similarity: number;
}
export type CompendiumResolution =
  | ({ status: 'ok' | 'changed' | 'moved'; changed: boolean } & CompendiumMatch)
  | {
      status: 'relink-suggested';
      candidate: CompendiumCandidate;
      candidates: CompendiumCandidate[];
    }
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
    const anchors = new Set(
      all.map(({ tab, row }) => JSON.stringify([tab.gid, row.anchor?.row, row.anchor?.col])),
    );
    for (const tab of data.tabs.filter((tab) => isTrackedCompendiumTab(tab.name))) {
      for (const entry of tab.grid ?? []) {
        if (!entry.cell.plain.trim()) continue;
        if (!anchors.has(JSON.stringify([tab.gid, entry.row, entry.col]))) {
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
    if (link.setBonusPieces) {
      if (match.tab.gid !== compendiumTabId('Armor Perks')) return { status: 'missing' };
      const cell = setBonusCell(match.row.cell, link.setBonusPieces);
      if (!cell) return { status: 'missing' };
      match.row = { ...match.row, cell };
      match.setBonusPieces = link.setBonusPieces;
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
  // Compare logical descriptions, including multipart labels, rather than fragments.
  // Human overrides always travel with their anchor and must resolve completely.
  const matches: CompendiumMatch[] = [];
  const groups = new Map<string, CompendiumMatch[]>();
  for (const entry of all) {
    const key = JSON.stringify([entry.tab.gid, entry.row.nameNorm, categoryOf(entry)]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const seen = new Set<string>();
  for (const entry of all) {
    if (link.cells) {
      const cell =
        entry.row.anchor && selectCompendiumCells(entry.tab, entry.row.anchor, link.cells);
      if (cell) matches.push({ ...entry, row: { ...entry.row, cell }, cells: link.cells });
    } else {
      const key = JSON.stringify([entry.tab.gid, entry.row.nameNorm, categoryOf(entry)]);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key)!;
      const combined = combineCompendiumMatches(group);
      if (combined) matches.push(combined);
      else matches.push(...group);
    }
  }
  const identical = matches.filter(
    (match) =>
      sameCell(link.snapshot, match.row.cell) &&
      JSON.stringify(link.parts ?? []) === JSON.stringify(match.parts ?? []),
  );
  if (identical.length === 1) return { ...identical[0], status: 'moved', changed: false };
  if (identical.length > 1)
    return {
      status: 'candidates',
      candidates: identical.slice(0, 3).map((match) => ({ ...match, similarity: 1 })),
    };
  const candidates = matches
    .map((match) => ({
      ...match,
      similarity: compendiumSimilarity(link.snapshot.plain, match.row.cell.plain, 0.6),
    }))
    .filter((candidate) => candidate.similarity >= 0.6)
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.tab.gid.localeCompare(b.tab.gid) ||
        a.row.rowIndex - b.row.rowIndex,
    )
    .slice(0, 3);
  if (
    candidates[0]?.similarity >= COMPENDIUM_RELINK_THRESHOLD &&
    candidates[0].similarity - (candidates[1]?.similarity ?? 0) >= COMPENDIUM_RELINK_MARGIN
  )
    return { status: 'relink-suggested', candidate: candidates[0], candidates };
  return candidates.length ? { status: 'candidates', candidates } : { status: 'missing' };
}
// Calibrated by relink-calibration.test.ts; suggestions still require human confirmation.
export const COMPENDIUM_RELINK_THRESHOLD = 0.98;
export const COMPENDIUM_RELINK_MARGIN = 0.15;
function categoryOf({ tab, row }: CompendiumMatch): string | undefined {
  return compendiumTabs[tab.gid]?.sectionCategories?.[row.section ?? ''];
}
// Recover the physical source components only when their styled concatenation
// exactly reproduces the parsed description. No guessing from adjacent text.
export function compendiumDescriptionCells({
  tab,
  row,
}: CompendiumMatch): CompendiumGridCell[] | undefined {
  if (!row.anchor) return;
  const cells = (tab.grid ?? [])
    .filter(
      (cell) =>
        cell.col > row.anchor!.col &&
        cell.row <= row.rowIndex &&
        cell.row + (cell.rowSpan ?? 1) > row.rowIndex &&
        cell.cell.plain.trim() &&
        row.cell.plain.includes(cell.cell.plain),
    )
    .sort((a, b) => a.col - b.col);
  const combined = normaliseRuns(
    cells.flatMap((cell, index) => [...(index ? [{ text: '\n' }] : []), ...cell.cell.runs]),
  );
  return cells.length && sameCell(combined, row.cell) ? cells : undefined;
}
const isCooldown = (cell: CompendiumGridCell) =>
  /(?:^|\n)(?:Base Cooldown|Chunk Scalar):/.test(cell.cell.plain);
// Combine only the same named thing in one tab; explicit category boundaries stay ambiguous.
export function combineCompendiumMatches(matches: CompendiumMatch[]): CompendiumMatch | undefined {
  if (!matches.length) return undefined;
  let sorted = [...matches].sort(
    (a, b) =>
      a.row.rowIndex - b.row.rowIndex || (a.row.anchor?.col ?? 0) - (b.row.anchor?.col ?? 0),
  );
  // Exotic armour can repeat its item name at the bottom of one merged card.
  // Deduplicate only anchors inside the SAME physical description cell.
  sorted = sorted.filter(
    (match, index) =>
      !sorted
        .slice(0, index)
        .some(
          (previous) =>
            match.tab.gid === compendiumTabId('Exotic Armors') &&
            previous.tab.gid === match.tab.gid &&
            match.row.nameNorm === previous.row.nameNorm &&
            match.row.anchor?.col === previous.row.anchor?.col &&
            sameCell(match.row.cell, previous.row.cell) &&
            match.tab.grid?.some(
              (cell) =>
                cell.col === (match.row.anchor?.col ?? -2) + 2 &&
                cell.row <= previous.row.rowIndex &&
                cell.row + (cell.rowSpan ?? 1) > match.row.rowIndex &&
                sameCell(cell.cell, match.row.cell),
            ),
        ),
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
  if (
    first.tab.gid === compendiumTabId('Artifact Perks') &&
    sorted.some((match) => !sameCell(match.row.cell, first.row.cell))
  )
    return undefined;
  if (sorted.length === 1) return { ...first };
  const components = sorted.map(compendiumDescriptionCells);
  const shared: CompendiumGridCell[] = [];
  for (const cells of components)
    for (const cell of cells ?? []) {
      if (
        isCooldown(cell) &&
        !shared.some((other) => sameCell(other.cell, cell.cell)) &&
        components.filter((group) => group?.some((other) => sameCell(other.cell, cell.cell)))
          .length > 1
      )
        shared.push(cell);
    }

  const parts = sorted.map(({ tab, row }, index) => {
    const cooldownLayout =
      shared.length > 0 && compendiumDescriptionCells({ tab, row })?.some(isCooldown);
    const context = tab.grid?.find(
      (entry) =>
        entry.row === row.rowIndex &&
        (!cooldownLayout || entry.col < (row.anchor?.col ?? 0)) &&
        entry.col !== row.anchor?.col &&
        entry.cell.plain.trim() &&
        entry.cell.plain !== row.cell.plain &&
        entry.cell.plain.trim() !== row.name,
    );
    const qualifier = /[([]([^()[\]]+)[)\]]\s*$/.exec(row.name)?.[1];
    // Artifact rows share names across current artifacts. A neighboring perk name
    // is not an artifact identity; reuse the actual enclosing artifact heading.
    const artifact =
      tab.gid === compendiumTabId('Artifact Perks')
        ? tab.grid
            ?.filter(
              (cell) =>
                cell.col === 3 &&
                cell.row < row.rowIndex &&
                /\s\([^()]+\)\s*$/.test(cell.cell.plain),
            )
            .sort((a, b) => b.row - a.row)[0]?.cell.plain
        : undefined;
    return (
      artifact ??
      qualifier ??
      context?.cell.plain.trim() ??
      (cooldownLayout ? row.name.split('\n')[0] : row.section) ??
      `Part ${index + 1}`
    );
  });
  return {
    tab: first.tab,
    parts,
    row: {
      ...first.row,
      cell: withBackground(
        normaliseRuns([
          ...sorted.flatMap(({ row }, index) => {
            const cells = components[index];
            const body =
              cells && shared.length
                ? normaliseRuns(
                    cells
                      .filter((cell) => !shared.some((other) => sameCell(other.cell, cell.cell)))
                      .flatMap((cell, i) => [...(i ? [{ text: '\n' }] : []), ...cell.cell.runs]),
                  )
                : row.cell;
            return [
              ...(index ? [{ text: '\n\n' }] : []),
              { text: `${parts[index]}\n`, bold: true as const },
              ...body.runs,
            ];
          }),
          ...shared.flatMap((cell) => [{ text: '\n\n' }, ...cell.cell.runs]),
        ]),
        first.row.cell.background,
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
    ...(match.setBonusPieces ? { setBonusPieces: match.setBonusPieces } : {}),
    // The sheet background is display-only and stays out of stored links.
    snapshot: withBackground(match.row.cell),
    snapshotAt: now,
  };
}
