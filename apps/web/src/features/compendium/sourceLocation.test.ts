import { describe, expect, it } from 'vitest';
import type { CompendiumData, CompendiumMatch } from '@clarity/core';
import {
  columnLabel,
  compendiumSheetId,
  linkLocation,
  matchLocation,
  regionRange,
  regionsOf,
  sourceHref,
} from './sourceLocation';

const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
const row = (name: string, anchor?: { row: number; col: number }) => ({
  name,
  nameNorm: name.toLowerCase(),
  rowIndex: anchor?.row ?? 5,
  section: 'Raid Specific',
  anchor,
  cell: cell(name),
});

describe('A1 ranges', () => {
  it('labels columns past Z', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLabel)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });

  it('writes a single cell and a rectangle', () => {
    expect(regionRange({ row: 12, col: 2, rows: 1, cols: 1 })).toBe('C12');
    expect(regionRange({ row: 12, col: 2, rows: 3, cols: 3 })).toBe('C12:E14');
  });

  it('merges adjacent cells into rectangles and keeps separate regions in order', () => {
    expect(
      regionsOf([
        { row: 12, col: 2 },
        { row: 12, col: 3 },
        { row: 13, col: 2 },
        { row: 13, col: 3 },
        { row: 20, col: 0 },
      ]).map(regionRange),
    ).toEqual(['C12:D13', 'A20']);
  });

  it('expands merged-cell spans', () => {
    expect(regionsOf([{ row: 4, col: 1, rows: 2, cols: 3 }]).map(regionRange)).toEqual(['B4:D5']);
  });
});

describe('source labels and links', () => {
  const tab = {
    gid: '77',
    name: 'Armor Mods',
    rows: [],
    grid: [{ row: 12, col: 2, rowSpan: 1, colSpan: 3, cell: cell('x') }],
  };
  const source: CompendiumData = { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] };

  it('uses the loaded grid span for the anchor even when the match tab is compact', () => {
    const match = { tab: { ...tab, grid: undefined }, row: row('Mod', { row: 12, col: 2 }) } as CompendiumMatch;
    const location = matchLocation(match, source);
    expect(location.label).toBe('Armor Mods · Raid Specific · C12:E12');
    expect(location.href).toBe(
      `https://docs.google.com/spreadsheets/d/${compendiumSheetId}/edit#gid=77&range=C12%3AE12`,
    );
  });

  it('lists several description regions in order and opens the first', () => {
    const match = {
      tab: { ...tab, grid: undefined },
      row: row('Mod', { row: 12, col: 0 }),
      cells: [
        { dRow: 0, dCol: 0 },
        { dRow: 0, dCol: 1 },
        { dRow: 8, dCol: 0 },
      ],
    } as CompendiumMatch;
    const location = matchLocation(match);
    expect(location.range).toBe('A12:B12, A20');
    expect(location.href).toContain('range=A12%3AB12');
  });

  it('falls back to the row number when the row has no anchor', () => {
    const match = { tab, row: row('Mod') } as CompendiumMatch;
    expect(matchLocation(match).range).toBe('5:5');
  });

  it('describes a saved link by its own anchor and tab name', () => {
    const location = linkLocation(
      { gid: '77', section: 'Seasonal', sourceAnchor: { row: 12, col: 2 } },
      source,
    );
    expect(location.label).toBe('Armor Mods · Seasonal · C12:E12');
    expect(sourceHref('9')).toBe(`https://docs.google.com/spreadsheets/d/${compendiumSheetId}/edit#gid=9`);
  });
});
