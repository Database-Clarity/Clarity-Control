import {
  compendiumCellAt,
  compendiumTabs,
  normaliseCompendiumName,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumMatch,
  type CompendiumPosition,
  type CompendiumSheet,
} from '@clarity/core';

/** The Compendium spreadsheet (the sheet itself, not htmlview). */
export const compendiumSheetId = '1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4';

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLabel(col: number): string {
  let label = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  }
  return label;
}

interface Region {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

/** A1 text of a region: `C12`, `C12:E14`. Grid rows are 1-based, columns 0-based. */
export function regionRange({ row, col, rows, cols }: Region): string {
  const first = `${columnLabel(col)}${row}`;
  return rows === 1 && cols === 1
    ? first
    : `${first}:${columnLabel(col + cols - 1)}${row + rows - 1}`;
}

/** Cell positions merged into rectangles (adjacent columns per row, then identical runs on adjacent rows). */
export function regionsOf(
  cells: readonly (CompendiumPosition & { rows?: number; cols?: number })[],
) {
  const byRow = new Map<number, [number, number][]>();
  for (const { row, col, rows = 1, cols = 1 } of cells) {
    for (let r = row; r < row + rows; r++) {
      const spans = byRow.get(r) ?? [];
      spans.push([col, col + cols - 1]);
      byRow.set(r, spans);
    }
  }
  const spansByRow = [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, spans]) => {
      const merged: [number, number][] = [];
      for (const span of spans.sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1);
        if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      return { row, merged };
    });
  const regions: Region[] = [];
  const open = new Map<string, Region>();
  let previousRow = Number.NaN;
  for (const { row, merged } of spansByRow) {
    const next = new Map<string, Region>();
    for (const [from, to] of merged) {
      const key = `${from}:${to}`;
      const above = row === previousRow + 1 ? open.get(key) : undefined;
      if (above) {
        above.rows++;
        next.set(key, above);
      } else {
        const region = { row, col: from, rows: 1, cols: to - from + 1 };
        regions.push(region);
        next.set(key, region);
      }
    }
    open.clear();
    for (const [key, region] of next) open.set(key, region);
    previousRow = row;
  }
  return regions;
}

export interface SourceLocation {
  /** `Armor Mods · Raid Specific · C12:E14` */
  label: string;
  /** Shorter label without the range, for narrow rows. */
  tab: string;
  section?: string;
  /** A1 ranges of each region in order; absent when the position is unknown. */
  range?: string;
  /** True when the sheet position is not known (no saved position, a stale snapshot). */
  unknown?: boolean;
  gid: string;
  href: string;
}

/** Shown in place of the range when the sheet position is not known; never an invented range. */
export const unknownPosition = 'position unknown';

/**
 * Some sheet "sections" are whole paragraphs (mod rules, mechanics notes); a location names only
 * their start, so a label stays one short line.
 */
export function sectionLabel(section: string | undefined): string | undefined {
  const text = section?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > sectionMax ? `${text.slice(0, sectionMax - 1).trimEnd()}…` : text;
}
const sectionMax = 40;

export function sourceHref(gid: string, range?: string): string {
  return `https://docs.google.com/spreadsheets/d/${compendiumSheetId}/edit#gid=${encodeURIComponent(
    gid,
  )}${range ? `&range=${encodeURIComponent(range)}` : ''}`;
}

/** One cell or merged region of a tab (e.g. the sheet cells around a candidate). */
export function cellLocation(tab: { gid: string; name: string }, region: Region): SourceLocation {
  const range = regionRange(region);
  return {
    tab: tab.name,
    range,
    gid: tab.gid,
    label: `${tab.name} · ${range}`,
    href: sourceHref(tab.gid, range),
  };
}

function spanAt(sheet: CompendiumSheet | undefined, position: CompendiumPosition) {
  const entry = sheet && compendiumCellAt(sheet, position);
  return entry
    ? { row: entry.row, col: entry.col, rows: entry.rowSpan ?? 1, cols: entry.colSpan ?? 1 }
    : { ...position, rows: 1, cols: 1 };
}

/**
 * The description cells of a parsed row, recovered from the loaded grid: the cells on the name's
 * rows (or, for card tabs, the row below) whose text, in reading order and joined by newlines, is
 * exactly the row's text. Undefined when they cannot be proven, so no range is ever guessed.
 */
export function descriptionCells(
  sheet: CompendiumSheet | undefined,
  anchor: CompendiumPosition,
  text: string,
) {
  const grid = sheet?.grid;
  if (!grid || !text) return undefined;
  const name = spanAt(sheet, anchor);
  const lastNameRow = name.row + name.rows - 1;
  for (const [first, last] of [
    [name.row, lastNameRow],
    [lastNameRow + 1, lastNameRow + 1],
  ]) {
    // Reading order as the parser read it: each row's cells left to right, including cells merged
    // down from a row above; a merged cell counts once.
    const entries = [];
    const seen = new Set<object>();
    for (let row = first; row <= last; row++)
      for (const entry of grid
        .filter(
          (cell) =>
            cell.row <= row &&
            cell.row + (cell.rowSpan ?? 1) > row &&
            !(cell.row === name.row && cell.col === name.col) &&
            cell.cell.plain.trim(),
        )
        .sort((a, b) => a.col - b.col))
        if (!seen.has(entry)) {
          seen.add(entry);
          entries.push(entry);
        }
    const picked = [];
    let at = 0;
    for (const entry of entries) {
      const plain = entry.cell.plain;
      if (!text.startsWith(plain, at)) continue;
      const end = at + plain.length;
      if (end !== text.length && text.charCodeAt(end) !== 10) continue; // a newline joins cells
      picked.push({
        row: entry.row,
        col: entry.col,
        rows: entry.rowSpan ?? 1,
        cols: entry.colSpan ?? 1,
      });
      at = end + 1;
      if (end === text.length) return picked;
    }
  }
  return undefined;
}

/**
 * The rows a multipart excerpt combines, in sheet order: rows of that name in the same section
 * category (the combiner never mixes categories) whose text leads, in order, in the combined
 * excerpt, with a repeated card (same text) counted once. Undefined unless exactly the excerpt's
 * part count is proven, so an unrelated same-name row is never named.
 */
function partRows(sheet: CompendiumSheet, row: CompendiumMatch['row'], count: number) {
  const categories = compendiumTabs[sheet.gid]?.sectionCategories;
  const category = categories?.[row.section ?? ''];
  const combined = row.cell.plain;
  const named = sheet.rows
    .filter(
      (other) =>
        other.nameNorm === row.nameNorm &&
        (!category ||
          !categories?.[other.section ?? ''] ||
          categories[other.section ?? ''] === category),
    )
    .sort((a, b) => a.rowIndex - b.rowIndex || (a.anchor?.col ?? 0) - (b.anchor?.col ?? 0));
  const inOrder = (rows: typeof named) => {
    let at = 0;
    return rows.filter((other) => {
      // Its first line: a cooldown shared by several parts is written once in the excerpt.
      const lead = other.cell.plain.split(String.fromCharCode(10))[0];
      const found = lead ? combined.indexOf(lead, at) : -1;
      if (found < 0) return false;
      at = found + lead.length;
      return true;
    });
  };
  const all = inOrder(named);
  if (all.length === count) return all;
  const distinct = inOrder(
    named.filter(
      (other, index) =>
        !named.slice(0, index).some((previous) => previous.cell.plain === other.cell.plain),
    ),
  );
  return distinct.length === count ? distinct : undefined;
}

/**
 * Where a candidate sits in the sheet, as text and an `edit#gid=&range=` link. The match's own tab
 * is compacted (no grid) in worker replies, so spans come from the loaded source by gid.
 */
export function matchLocation(
  match: Pick<CompendiumMatch, 'tab' | 'row' | 'cells' | 'sourceAnchor' | 'parts'>,
  source?: CompendiumData | null,
): SourceLocation {
  const sheet = source?.tabs.find((tab) => tab.gid === match.tab.gid) ?? match.tab;
  const anchor = match.sourceAnchor ?? match.row.anchor;
  let range: string | undefined;
  if (anchor && match.cells?.length) {
    range = regionsOf(
      match.cells.map(({ dRow, dCol }) =>
        spanAt(sheet, { row: anchor.row + dRow, col: anchor.col + dCol }),
      ),
    )
      .map(regionRange)
      .join(', ');
  } else if (anchor && match.parts && match.parts.length > 1 && sheet.rows.length) {
    // A multipart excerpt joins every row of the same name in this tab, each under a heading:
    // name each part's own description cells, in order.
    range = partRows(sheet, match.row, match.parts.length)
      ?.map((part) => {
        const cells = part.anchor && descriptionCells(sheet, part.anchor, part.cell.plain);
        return cells ? cells.map(regionRange).join(', ') : `${part.rowIndex}:${part.rowIndex}`;
      })
      .join(', ');
  } else if (anchor) {
    // A parsed row is anchored on its NAME cell; the excerpt shown is its description cells.
    const cells = descriptionCells(sheet, anchor, match.row.cell.plain);
    range = cells ? cells.map(regionRange).join(', ') : `${anchor.row}:${anchor.row}`;
  } else if (match.row.rowIndex) range = `${match.row.rowIndex}:${match.row.rowIndex}`;
  const section = sectionLabel(match.row.section);
  return {
    tab: match.tab.name,
    section,
    range,
    unknown: !range || undefined,
    gid: match.tab.gid,
    label: [match.tab.name, section, range ?? unknownPosition].filter(Boolean).join(' · '),
    // The sheet takes one range in the hash; several regions open on the first.
    href: sourceHref(match.tab.gid, range?.split(', ')[0]),
  };
}

/**
 * The saved link's own place (a draft or saved Compendium link). `stale` marks a snapshot whose row
 * no longer resolves: its saved position may be wrong, so only the tab is linked. The same holds,
 * with the source loaded, when the saved anchor cell is gone or no longer holds the row's name, or
 * when any selected description cell is gone.
 */
export function linkLocation(
  link: Pick<CompendiumLink, 'gid' | 'section' | 'sourceAnchor' | 'cells'> &
    Partial<Pick<CompendiumLink, 'rowKey'>>,
  source?: CompendiumData | null,
  { stale = false }: { stale?: boolean } = {},
): SourceLocation {
  const sheet = source?.tabs.find((tab) => tab.gid === link.gid);
  // With the source loaded, a saved anchor whose name cell is gone or renamed is stale too.
  const anchorCell = sheet && link.sourceAnchor && compendiumCellAt(sheet, link.sourceAnchor);
  const moved =
    !!source &&
    !!link.sourceAnchor &&
    (!anchorCell ||
      (link.rowKey !== undefined &&
        normaliseCompendiumName(anchorCell.cell.plain.trim()) !==
          normaliseCompendiumName(link.rowKey)));
  // ...and so is a selection whose description cells are no longer in the sheet.
  const lostCells =
    !!sheet &&
    !!link.sourceAnchor &&
    !!link.cells?.some(
      ({ dRow, dCol }) =>
        !compendiumCellAt(sheet, {
          row: link.sourceAnchor!.row + dRow,
          col: link.sourceAnchor!.col + dCol,
        }),
    );
  const anchor = stale || moved || lostCells ? undefined : link.sourceAnchor;
  const range = anchor
    ? link.cells?.length
      ? regionsOf(
          link.cells.map(({ dRow, dCol }) =>
            spanAt(sheet, { row: anchor.row + dRow, col: anchor.col + dCol }),
          ),
        )
          .map(regionRange)
          .join(', ')
      : regionRange(spanAt(sheet, anchor))
    : undefined;
  // The tab's name comes from the loaded source; a raw gid is never shown.
  const tab = sheet?.name ?? (source ? 'Removed sheet tab' : 'Sheet tab');
  const section = sectionLabel(link.section);
  return {
    tab,
    section,
    range,
    unknown: !range || undefined,
    gid: link.gid,
    label: [tab, section, range ?? unknownPosition].filter(Boolean).join(' · '),
    href: sourceHref(link.gid, range?.split(', ')[0]),
  };
}
