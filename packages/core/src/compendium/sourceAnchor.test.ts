import { expect, it } from 'vitest';
import { compendiumDataSchema, resolveCompendiumLink, snapshotCompendium } from './index.js';

it('keeps explicit same-name card picks concise and fails closed when their anchor vanishes', () => {
  const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
  const data = compendiumDataSchema.parse({
    fetchedAt: '2026-11-04T00:00:00Z',
    tabs: [
      {
        gid: '1662574278',
        name: 'Weapon Perks',
        rows: [53, 54].map((row) => ({
          name: 'Same Perk',
          nameNorm: 'same perk',
          rowIndex: row,
          anchor: { row, col: 0 },
          cell: cell('body ' + row),
        })),
        grid: [53, 54].map((row) => ({ row, col: 2, cell: cell('body ' + row) })),
      },
    ],
  });
  const tab = data.tabs[0];
  const link = snapshotCompendium({
    tab,
    row: tab.rows[0],
    cells: [{ dRow: 0, dCol: 2 }],
    sourceAnchor: tab.rows[0].anchor,
  });
  expect(link.rowKey).toBe('Same Perk');
  expect(resolveCompendiumLink(link, data)).toMatchObject({ status: 'ok', row: { rowIndex: 53 } });
  tab.rows[0].cell = cell('Changed');
  tab.grid![0].cell = cell('Changed');
  expect(resolveCompendiumLink(link, data)).toMatchObject({
    status: 'changed',
    row: { rowIndex: 53 },
  });
  tab.rows.shift();
  expect(resolveCompendiumLink(link, data)).toEqual({ status: 'missing' });
});
