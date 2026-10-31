import { expect, it } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { compendiumChanges } from './tracking';
const cell = { plain: 'text', runs: [{ text: 'text', color: '#6fa8dc' }] };
const data: CompendiumData = {
  fetchedAt: '2026-10-27T00:00:00Z',
  tabs: [
    {
      gid: '1',
      name: 'Weapon Perks',
      rows: [{ name: 'Test', nameNorm: 'test', rowIndex: 1, cell }],
    },
  ],
};
const tooltip = (hash: number, snapshot = cell, date = '2026-10-01T00:00:00Z'): Tooltip => ({
  hash,
  text: {},
  associated: [],
  compendium: { gid: '1', rowKey: 'Test', snapshot, snapshotAt: date },
});
it('lists style/text changes and relinks distinctly, newest snapshots first, without unlinked/equal rows', () => {
  const missing = {
    ...tooltip(3),
    compendium: {
      ...tooltip(3).compendium!,
      rowKey: 'Gone',
      snapshot: { plain: 'unrelated', runs: [{ text: 'unrelated' }] },
    },
  };
  const result = compendiumChanges(
    {
      1: tooltip(1),
      2: tooltip(
        2,
        { plain: 'text', runs: [{ text: 'text', color: '#dd7e6b' }] },
        '2026-10-26T00:00:00Z',
      ),
      3: missing,
      4: { hash: 4, text: {}, associated: [] },
    },
    data,
  );
  expect(result.map((entry) => [entry.tooltip.hash, entry.resolution.status])).toEqual([
    [2, 'changed'],
    [3, 'missing'],
  ]);
});
