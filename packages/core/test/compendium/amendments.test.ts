import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { autoLinkCompendium } from '../../src/compendium/link.js';
import {
  combineCompendiumMatches,
  resolveCompendiumLink,
  snapshotCompendium,
} from '../../src/compendium/resolve.js';
import {
  compendiumSheetSchema,
  type CompendiumData,
  type CompendiumLink,
} from '../../src/compendium/types.js';
const now = '2026-10-31T00:00:00Z';
const cell = (text: string) => ({ plain: text, runs: [{ text, color: '#6fa8dc' }] });
const sheet = compendiumSheetSchema.parse(
  JSON.parse(readFileSync(new URL('./fixtures/intrinsic.json', import.meta.url), 'utf8')),
);
const data: CompendiumData = { fetchedAt: now, tabs: [sheet] };
const combined = combineCompendiumMatches(sheet.rows.map((row) => ({ tab: sheet, row })))!;
it('combines real Aggressive Frame variants with bold labels, styles and sheet order', () => {
  expect(sheet.rows).toHaveLength(5);
  expect(combined.parts).toEqual([
    'Intrinsic Traits',
    'Fusion Rifles',
    'Rocket Launchers',
    'Scout Rifles',
    'Shotguns',
  ]);
  expect(
    combined.row.cell.runs
      .filter((run) => run.bold)
      .map((run) => run.text)
      .join(''),
  ).toContain('Shotguns');
  expect(combined.row.cell.plain).toContain('\n\nFusion Rifles\n');
  const link = snapshotCompendium(combined, now);
  expect(resolveCompendiumLink(link, data).status).toBe('ok');
  const tooltip = { hash: 123, associated: [], text: {} };
  const result = autoLinkCompendium(
    tooltip,
    { 123: { hash: 123, name: 'Aggressive Frame', categoryId: 'weapon-frame' } },
    {},
    data,
    now,
  );
  expect(result.next?.compendium?.parts).toEqual(combined.parts);
});
it('detects added, removed and reordered real parts, but ignores absolute sheet row shifts', () => {
  const link = snapshotCompendium(combined, now);
  const variants = [
    sheet.rows.slice(1),
    [...sheet.rows, { ...sheet.rows[0], rowIndex: 999, anchor: { row: 999, col: 0 } }],
    sheet.rows.map((row, i) => ({ ...row, rowIndex: i === 0 ? 999 : row.rowIndex })),
  ];
  for (const rows of variants)
    expect(resolveCompendiumLink(link, { ...data, tabs: [{ ...sheet, rows }] })).toMatchObject({
      changed: true,
    });
  expect(
    resolveCompendiumLink(link, {
      ...data,
      tabs: [
        { ...sheet, rows: sheet.rows.map((row) => ({ ...row, rowIndex: row.rowIndex + 20 })) },
      ],
    }),
  ).toMatchObject({ status: 'ok' });
});
it('keeps explicitly configured cross-category duplicate names ambiguous', () => {
  const rows = [
    { ...sheet.rows[0], section: 'Weapon Traits' },
    { ...sheet.rows[0], section: 'Intrinsic Traits', rowIndex: 999 },
  ];
  expect(
    resolveCompendiumLink(
      { ...snapshotCompendium(combined, now), section: undefined },
      {
        ...data,
        tabs: [{ ...sheet, rows }],
      },
    ).status,
  ).toBe('candidates');
});
const offsets = [
  { dRow: 2, dCol: 3 },
  { dRow: 1, dCol: 2 },
];
const override: CompendiumLink = {
  gid: '1',
  rowKey: 'Anchor',
  cells: offsets,
  snapshot: {
    plain: 'second\nfirst',
    runs: [...cell('second').runs, { text: '\n' }, ...cell('first').runs],
  },
  snapshotAt: now,
};
function overridden(row = 10, gid = '1', name = 'Anchor'): CompendiumData {
  return {
    fetchedAt: now,
    tabs: [
      {
        gid,
        name: 'Sheet',
        rows: [],
        grid: [
          { row, col: 1, cell: cell(name) },
          { row: row + 1, col: 3, colSpan: 2, cell: cell('first') },
          { row: row + 2, col: 4, cell: cell('second') },
        ],
      },
    ],
  };
}
it('follows an arbitrary human anchor on moved rows/tabs and keeps click order and offsets on snapshot', () => {
  for (const data of [overridden(), overridden(30), overridden(30, '2', 'Ánchor!')]) {
    const result = resolveCompendiumLink(override, data);
    expect(result).toMatchObject({ changed: false, row: { cell: { plain: 'second\nfirst' } } });
    if (!('row' in result)) throw new Error('Expected resolved override');
    expect(snapshotCompendium(result, now).cells).toEqual(offsets);
  }
});
it('requires relink on empty, missing or duplicated merged-cell targets instead of guessing', () => {
  const data = overridden();
  data.tabs[0].grid!.pop();
  expect(resolveCompendiumLink(override, data).status).toBe('missing');
  expect(
    resolveCompendiumLink(
      {
        ...override,
        cells: [
          { dRow: 1, dCol: 2 },
          { dRow: 1, dCol: 3 },
        ],
      },
      overridden(),
    ).status,
  ).toBe('missing');
  const blank = overridden();
  blank.tabs[0].grid![2].cell = cell('  ');
  expect(resolveCompendiumLink(override, blank).status).toBe('missing');
});
it('human offsets override automatic multipart content', () => {
  const anchor = sheet.rows[0].anchor!;
  const source = {
    ...sheet,
    grid: [...sheet.grid!, { row: anchor.row + 1, col: 30, cell: cell('human choice') }],
  };
  const result = resolveCompendiumLink(
    { ...snapshotCompendium(combined, now), cells: [{ dRow: 1, dCol: 30 - anchor.col }] },
    { ...data, tabs: [source] },
  );
  expect(result).toMatchObject({ row: { cell: { plain: 'human choice' } } });
  expect('parts' in result).toBe(false);
});
