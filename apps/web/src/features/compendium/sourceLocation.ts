import {
  compendiumCellAt,
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
export function regionsOf(cells: readonly (CompendiumPosition & { rows?: number; cols?: number })[]) {
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
  range?: string;
  gid: string;
  href: string;
}

export function sourceHref(gid: string, range?: string): string {
  return `https://docs.google.com/spreadsheets/d/${compendiumSheetId}/edit#gid=${encodeURIComponent(
    gid,
  )}${range ? `&range=${encodeURIComponent(range)}` : ''}`;
}

function spanAt(sheet: CompendiumSheet | undefined, position: CompendiumPosition) {
  const entry = sheet && compendiumCellAt(sheet, position);
  return entry
    ? { row: entry.row, col: entry.col, rows: entry.rowSpan ?? 1, cols: entry.colSpan ?? 1 }
    : { ...position, rows: 1, cols: 1 };
}

/**
 * Where a candidate sits in the sheet, as text and an `edit#gid=&range=` link. The match's own tab
 * is compacted (no grid) in worker replies, so spans come from the loaded source by gid.
 */
export function matchLocation(
  match: Pick<CompendiumMatch, 'tab' | 'row' | 'cells' | 'sourceAnchor'>,
  source?: CompendiumData | null,
): SourceLocation {
  const sheet = source?.tabs.find((tab) => tab.gid === match.tab.gid) ?? match.tab;
  const anchor = match.sourceAnchor ?? match.row.anchor;
  let range: string | undefined;
  if (anchor && match.cells?.length) {
    range = regionsOf(
      match.cells.map(({ dRow, dCol }) => spanAt(sheet, { row: anchor.row + dRow, col: anchor.col + dCol })),
    )
      .map(regionRange)
      .join(', ');
  } else if (anchor) range = regionRange(spanAt(sheet, anchor));
  else if (match.row.rowIndex) range = `${match.row.rowIndex}:${match.row.rowIndex}`;
  const section = match.row.section;
  return {
    tab: match.tab.name,
    section,
    range,
    gid: match.tab.gid,
    label: [match.tab.name, section, range].filter(Boolean).join(' · '),
    // The sheet takes one range in the hash; several regions open on the first.
    href: sourceHref(match.tab.gid, range?.split(', ')[0]),
  };
}

/** The saved link's own place (a draft or saved Compendium link). */
export function linkLocation(
  link: Pick<CompendiumLink, 'gid' | 'section' | 'sourceAnchor' | 'cells'>,
  source?: CompendiumData | null,
): SourceLocation {
  const sheet = source?.tabs.find((tab) => tab.gid === link.gid);
  const anchor = link.sourceAnchor;
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
  const tab = sheet?.name ?? `Tab ${link.gid}`;
  return {
    tab,
    section: link.section,
    range,
    gid: link.gid,
    label: [tab, link.section, range].filter(Boolean).join(' · '),
    href: sourceHref(link.gid, range?.split(', ')[0]),
  };
}
