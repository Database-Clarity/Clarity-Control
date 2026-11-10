import { describe, expect, it } from 'vitest';
import type { CompendiumData, CompendiumMatch } from '@clarity/core';
import {
  cellLocation,
  columnLabel,
  compendiumSheetId,
  descriptionCells,
  linkLocation,
  matchLocation,
  regionRange,
  regionsOf,
  sectionLabel,
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
    grid: [
      { row: 12, col: 0, cell: cell('Mod') },
      { row: 12, col: 2, rowSpan: 1, colSpan: 3, cell: cell('x') },
    ],
  };
  const source: CompendiumData = { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] };

  it('labels the description cells, not the name, using the loaded grid when the match is compact', () => {
    const match = {
      tab: { ...tab, grid: undefined },
      row: { ...row('Mod', { row: 12, col: 0 }), cell: cell('x') },
    } as CompendiumMatch;
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
    expect(sourceHref('9')).toBe(
      `https://docs.google.com/spreadsheets/d/${compendiumSheetId}/edit#gid=9`,
    );
  });

  it("lists a saved link's regions in order and expands merged cells", () => {
    const location = linkLocation(
      {
        gid: '77',
        sourceAnchor: { row: 12, col: 2 },
        cells: [
          { dRow: 0, dCol: 0 },
          { dRow: 3, dCol: -2 },
          { dRow: 4, dCol: -2 },
        ],
      },
      source,
    );
    expect(location.range).toBe('C12:E12, A15:A16');
    expect(location.label).toBe('Armor Mods · C12:E12, A15:A16');
    expect(location.href).toContain('gid=77&range=C12%3AE12');
    expect(location.unknown).toBeUndefined();
  });

  it('says the position is unknown without inventing a range', () => {
    const old = linkLocation({ gid: '77', section: 'Seasonal' }, source);
    expect(old.range).toBeUndefined();
    expect(old.unknown).toBe(true);
    expect(old.label).toBe('Armor Mods · Seasonal · position unknown');
    expect(old.href).toBe(sourceHref('77'));

    const stale = linkLocation({ gid: '77', sourceAnchor: { row: 12, col: 2 } }, source, {
      stale: true,
    });
    expect(stale.label).toBe('Armor Mods · position unknown');
    expect(stale.href).not.toContain('range=');
  });

  it('never shows a raw gid as the tab name', () => {
    expect(linkLocation({ gid: '123456' }, source).tab).toBe('Removed sheet tab');
    expect(linkLocation({ gid: '123456' }).tab).toBe('Sheet tab');
    expect(linkLocation({ gid: '123456' }).label).not.toContain('123456');
  });

  it('labels one sheet cell by its A1 address', () => {
    const location = cellLocation(tab, { row: 14, col: 27, rows: 2, cols: 1 });
    expect(location.label).toBe('Armor Mods · AB14:AB15');
    expect(location.href).toContain('range=AB14%3AAB15');
  });

  it('names only the start of a paragraph-long section', () => {
    const prose =
      'Enhanced Weapon Mods are equippable only on Tier 4 and Tier 5 Weapons. They also cost more.';
    const location = linkLocation(
      {
        gid: '77',
        section: prose,
        sourceAnchor: { row: 12, col: 2 },
        cells: [{ dRow: 0, dCol: 0 }],
      },
      source,
    );
    expect(location.section!.length).toBeLessThanOrEqual(40);
    expect(location.section!.endsWith('…')).toBe(true);
    expect(location.label).toBe(`Armor Mods · ${location.section} · C12:E12`);
    expect(sectionLabel('  Raid   Specific ')).toBe('Raid Specific');
  });

  it('finds description cells merged down from the row above, in reading order', () => {
    const sheet = {
      gid: '9',
      name: 'Arc',
      rows: [],
      grid: [
        { row: 35, col: 13, rowSpan: 2, cell: cell('Cooldown') },
        { row: 36, col: 1, cell: cell('Touch of Thunder') },
        { row: 36, col: 3, colSpan: 10, cell: cell('Explodes again') },
      ],
    };
    const text = ['Explodes again', 'Cooldown'].join(String.fromCharCode(10));
    const cells = descriptionCells(sheet, { row: 36, col: 1 }, text);
    expect(cells!.map(regionRange)).toEqual(['D36:M36', 'N35:N36']);
    // Unproven text never borrows the name cell: the row is named instead.
    expect(descriptionCells(sheet, { row: 36, col: 1 }, 'Other text')).toBeUndefined();
    const match = {
      tab: sheet,
      row: { ...row('Touch of Thunder', { row: 36, col: 1 }), cell: cell('Other') },
    };
    expect(matchLocation(match as CompendiumMatch).range).toBe('36:36');
  });

  it('treats a saved anchor whose name cell changed as position unknown', () => {
    const renamed = linkLocation(
      {
        gid: '77',
        rowKey: 'Old name',
        sourceAnchor: { row: 12, col: 0 },
        cells: [{ dRow: 0, dCol: 2 }],
      },
      source,
    );
    expect(renamed.unknown).toBe(true);
    expect(renamed.href).not.toContain('range=');
    const same = linkLocation(
      {
        gid: '77',
        rowKey: 'Mod',
        sourceAnchor: { row: 12, col: 0 },
        cells: [{ dRow: 0, dCol: 2 }],
      },
      source,
    );
    expect(same.range).toBe('C12:E12');
  });
});
