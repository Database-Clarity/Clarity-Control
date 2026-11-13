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
import {
  compendiumIdentifiers,
  compendiumTabId,
  compendiumTabs,
  isTrackedCompendiumTab,
} from './config.js';
import { setBonusCell } from './setBonus.js';
import { selectCompendiumCells } from './cells.js';

// Matching compares the same source descriptions with many tooltips. Cache only
// pure text transforms, keyed by the complete text, so refreshed or edited inputs
// cannot reuse an earlier source's meaning. Both memory and entry count are bounded.
const normalized = new Map<string, string>();
let normalizedCharacters = 0;
const gramSets = new Map<string, Float64Array>();
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
// A trigram as one exact number: three UTF-16 code units below 2^48. A normalized
// text shorter than three units is its own single gram, kept in a disjoint negative
// range (length, then units). Sorted unique codes give the same gram set sizes and
// intersections as the former string sets, in compact arrays that let the cache
// hold every source description and tooltip text at once (it used to thrash).
const UNIT = 0x10000;
function gramCodes(value: string): Float64Array {
  if (value.length < 3) {
    const first = value.length > 0 ? value.charCodeAt(0) : 0;
    const second = value.length > 1 ? value.charCodeAt(1) : 0;
    return Float64Array.of(-(1 + value.length * UNIT * UNIT + first * UNIT + second));
  }
  const codes = new Float64Array(value.length - 2);
  for (let index = 0; index < codes.length; index++)
    codes[index] =
      (value.charCodeAt(index) * UNIT + value.charCodeAt(index + 1)) * UNIT +
      value.charCodeAt(index + 2);
  codes.sort();
  let unique = 0;
  for (let index = 0; index < codes.length; index++)
    if (index === 0 || codes[index] !== codes[unique - 1]) codes[unique++] = codes[index];
  return codes.subarray(0, unique);
}
function grams(text: string): Float64Array {
  const cached = gramSets.get(text);
  if (cached) return cached;
  const result = gramCodes(normaliseCompendiumName(text));
  if (result.length <= 2_000_000 && text.length <= 8_000_000) {
    while (
      gramSets.size >= 16384 ||
      cachedGrams + result.length > 2_000_000 ||
      gramCharacters + text.length > 8_000_000
    ) {
      const [key, old] = gramSets.entries().next().value!;
      gramSets.delete(key);
      cachedGrams -= old.length;
      gramCharacters -= key.length;
    }
    gramSets.set(text, result);
    cachedGrams += result.length;
    gramCharacters += text.length;
  }
  return result;
}
/** A positive minimum may return zero only for scores that cannot reach that minimum. */
export function compendiumSimilarity(left: string, right: string, minimum = 0): number {
  if (!left.trim() || !right.trim()) return left === right ? 1 : 0;
  const a = grams(left);
  const b = grams(right);
  const smaller = a.length <= b.length ? a : b;
  if ((2 * smaller.length) / (a.length + b.length) < minimum) return 0;
  let common = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      common++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return (2 * common) / (a.length + b.length);
}
export interface CompendiumMatch {
  tab: CompendiumSheet;
  row: CompendiumRow;
  parts?: string[];
  /** Read-only provenance of a combined result, in the resolver's component order. Not saved. */
  readonly componentRows?: readonly Readonly<CompendiumRow>[];
  cells?: CompendiumLink['cells'];
  sourceAnchor?: CompendiumLink['sourceAnchor'];
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

type RowLookup = {
  rawTab: Map<string, CompendiumMatch[]>;
  normalizedTab: Map<string, CompendiumMatch[]>;
  normalized: Map<string, CompendiumMatch[]>;
};
type IdentifierLookup = {
  /** Row positions, ascending, for each compendiumIdentifiers value. */
  raw: Map<string, number[]>;
  /** Row positions, ascending, for each normalized compendiumIdentifiers value. */
  normalized: Map<string, number[]>;
};
type MatchingContext = {
  data: CompendiumData;
  rows?: CompendiumMatch[];
  cellRows?: CompendiumMatch[];
  lookups: WeakMap<readonly CompendiumMatch[], RowLookup>;
  identifiers?: WeakMap<readonly CompendiumMatch[], IdentifierLookup>;
  logical?: WeakMap<readonly CompendiumMatch[], readonly CompendiumMatch[]>;
};
let matchingContext: MatchingContext | undefined;
const retainedContexts = new WeakMap<CompendiumData, MatchingContext>();

/**
 * Keep this source's lookups across later withCompendiumMatchingIndex calls.
 * Only for a source that is never mutated afterwards (the proposals worker replaces,
 * never edits, its source): sliced matching otherwise rebuilt every index per slice.
 */
export function retainCompendiumMatchingIndex(data: CompendiumData) {
  if (!retainedContexts.has(data)) retainedContexts.set(data, { data, lookups: new WeakMap() });
}

/** Share lookups during one synchronous, read-only computation over this source. */
export function withCompendiumMatchingIndex<T>(data: CompendiumData, compute: () => T): T {
  if (matchingContext?.data === data) return compute();
  const previous = matchingContext;
  matchingContext = retainedContexts.get(data) ?? { data, lookups: new WeakMap() };
  try {
    return compute();
  } finally {
    matchingContext = previous;
  }
}

/** Ordered rows; ordinary callers retain a fresh view of their mutable inputs. */
export function compendiumMatches(
  data: CompendiumData,
  includeGridAnchors = false,
): readonly CompendiumMatch[] {
  const context = matchingContext?.data === data ? matchingContext : undefined;
  const cached = includeGridAnchors ? context?.cellRows : context?.rows;
  if (cached) return cached;
  const rows: CompendiumMatch[] = includeGridAnchors
    ? [...compendiumMatches(data)]
    : data.tabs
        .filter((tab) => isTrackedCompendiumTab(tab.name))
        .flatMap((tab) => tab.rows.map((row) => ({ tab, row })));
  if (includeGridAnchors) {
    const anchors = new Set(
      rows.map(({ tab, row }) => JSON.stringify([tab.gid, row.anchor?.row, row.anchor?.col])),
    );
    for (const tab of data.tabs.filter((tab) => isTrackedCompendiumTab(tab.name))) {
      for (const entry of tab.grid ?? []) {
        if (!entry.cell.plain.trim()) continue;
        if (!anchors.has(JSON.stringify([tab.gid, entry.row, entry.col])))
          rows.push({
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
  if (context) {
    if (includeGridAnchors) context.cellRows = rows;
    else context.rows = rows;
  }
  return rows;
}

function matchingLookup(data: CompendiumData, rows: readonly CompendiumMatch[]) {
  if (matchingContext?.data !== data) return;
  const cached = matchingContext.lookups.get(rows);
  if (cached) return cached;
  const index: RowLookup = {
    rawTab: new Map(),
    normalizedTab: new Map(),
    normalized: new Map(),
  };
  const add = (map: Map<string, CompendiumMatch[]>, key: string, match: CompendiumMatch) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(match);
    else map.set(key, [match]);
  };
  for (const match of rows) {
    add(index.rawTab, JSON.stringify([match.tab.gid, match.row.name]), match);
    add(index.normalizedTab, JSON.stringify([match.tab.gid, match.row.nameNorm]), match);
    add(index.normalized, match.row.nameNorm, match);
  }
  matchingContext.lookups.set(rows, index);
  return index;
}

/**
 * Inside withCompendiumMatchingIndex: which positions of `rows` have a given
 * (normalized) compendiumIdentifiers value. Undefined outside an index.
 */
export function compendiumIdentifierLookup(
  data: CompendiumData,
  rows: readonly CompendiumMatch[],
): IdentifierLookup | undefined {
  if (matchingContext?.data !== data) return;
  const identifiers = (matchingContext.identifiers ??= new WeakMap());
  const cached = identifiers.get(rows);
  if (cached) return cached;
  const lookup: IdentifierLookup = { raw: new Map(), normalized: new Map() };
  const add = (map: Map<string, number[]>, key: string, position: number) => {
    const bucket = map.get(key);
    if (!bucket) map.set(key, [position]);
    else if (bucket[bucket.length - 1] !== position) bucket.push(position);
  };
  rows.forEach(({ row }, position) => {
    for (const identifier of compendiumIdentifiers(row.name)) {
      add(lookup.raw, identifier, position);
      add(lookup.normalized, normaliseCompendiumName(identifier), position);
    }
  });
  identifiers.set(rows, lookup);
  return lookup;
}

export function resolveCompendiumLink(
  link: CompendiumLink,
  data: CompendiumData,
): CompendiumResolution {
  // An arbitrary human-picked anchor need not be one of the parsed named rows.
  const all = compendiumMatches(data, !!link.cells);
  const index = matchingLookup(data, all);
  const normalizedKey = normaliseCompendiumName(link.rowKey);
  let found = index
    ? (index.rawTab.get(JSON.stringify([link.gid, link.rowKey])) ?? [])
    : all.filter(({ tab, row }) => tab.gid === link.gid && row.name === link.rowKey);
  if (found.length && !link.cells)
    found = index
      ? (index.normalizedTab.get(JSON.stringify([link.gid, normalizedKey])) ?? [])
      : all.filter(({ tab, row }) => tab.gid === link.gid && row.nameNorm === normalizedKey);
  let moved = false;
  if (link.sourceAnchor) {
    if (!link.cells) return { status: 'missing' };
    found = found.filter(
      ({ row }) =>
        row.anchor?.row === link.sourceAnchor!.row && row.anchor.col === link.sourceAnchor!.col,
    );
    // Explicit duplicate-card selections cannot silently jump to another row.
    if (found.length !== 1) return { status: 'missing' };
  }
  if (!found.length) {
    found = index
      ? (index.normalized.get(normalizedKey) ?? [])
      : all.filter(({ row }) => row.nameNorm === normalizedKey);
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
    const combined = link.cells
      ? found.length === 1
        ? found[0]
        : undefined
      : combineCompendiumMatches(found);
    // Cell/set projections must not mutate a shared lookup row.
    const match = combined && { ...combined };
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
      match.sourceAnchor = link.sourceAnchor;
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
  const matches: readonly CompendiumMatch[] = link.cells
    ? all.flatMap((entry) => {
        const cell =
          entry.row.anchor && selectCompendiumCells(entry.tab, entry.row.anchor, link.cells!);
        return cell ? [{ ...entry, row: { ...entry.row, cell }, cells: link.cells }] : [];
      })
    : logicalCompendiumMatches(data, all);
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
/**
 * Every logical description in source order: one combined match per same-name
 * group, or the group's rows when they do not combine. It depends on the rows
 * alone, so an index computes it once; results are copied, never edited.
 */
function logicalCompendiumMatches(
  data: CompendiumData,
  all: readonly CompendiumMatch[],
): readonly CompendiumMatch[] {
  const context = matchingContext?.data === data ? matchingContext : undefined;
  const cached = context?.logical?.get(all);
  if (cached) return cached;
  const matches: CompendiumMatch[] = [];
  const groups = new Map<string, CompendiumMatch[]>();
  const keys = all.map((entry) =>
    JSON.stringify([entry.tab.gid, entry.row.nameNorm, categoryOf(entry)]),
  );
  all.forEach((entry, index) => {
    const group = groups.get(keys[index]) ?? [];
    group.push(entry);
    groups.set(keys[index], group);
  });
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const group = groups.get(key)!;
    const combined = combineCompendiumMatches(group);
    if (combined) matches.push(combined);
    else matches.push(...group);
  }
  if (context) (context.logical ??= new WeakMap()).set(all, matches);
  return matches;
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
  const exoticArmors = compendiumTabId('Exotic Armors');
  sorted = sorted.filter(
    (match, index) =>
      !sorted
        .slice(0, index)
        .some(
          (previous) =>
            match.tab.gid === exoticArmors &&
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
    componentRows: sorted.map(({ row }) => row),
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
    ...(match.sourceAnchor ? { sourceAnchor: match.sourceAnchor } : {}),
    ...(match.parts ? { parts: match.parts } : {}),
    ...(match.setBonusPieces ? { setBonusPieces: match.setBonusPieces } : {}),
    // The sheet background is display-only and stays out of stored links.
    snapshot: withBackground(match.row.cell),
    snapshotAt: now,
  };
}
