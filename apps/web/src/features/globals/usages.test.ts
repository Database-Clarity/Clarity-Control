import { describe, expect, it } from 'vitest';
import type { GlobalRecord, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { buildGlobalUsageIndex } from './usages';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
});
const entry = (id: string, kind: GlobalRecord['kind'], name: string, body: string) =>
  ({
    version: 1,
    id,
    kind,
    name,
    revision: 'r1',
    definitions: { en: { body } },
    nameHistory: [],
  }) as unknown as GlobalRecord;
const item = (hash: number) => ({ hash, name: `Item ${hash}`, icon: '', categoryId: 'perk' });

const entries = [
  entry('g_damage0001', 'variables', 'Damage', '10%'),
  entry('g_arrow00001', 'variables', 'e', '🡅'),
  entry('g_title00001', 'titles', 'Reload', 'Reloads by #Damage.'),
  entry('g_export0001', 'exports', 'anti_barrier', 'Pierces shields.'),
];
const data = {
  categories: [],
  items: Object.fromEntries([10, 11, 12, 13, 14, 15, 20].map((hash) => [hash, item(hash)])),
  aliases: { 20: { to: 10, kind: 'sandbox' } },
  bundle: {
    tooltips: {
      2: tooltip(2, 'var Damage = 10%\nvar e = 🡅'),
      10: tooltip(10, 'Deals #Damage more.'),
      11: tooltip(11, 'Intro\nimport Perk from 12'),
      12: tooltip(12, 'export Perk (\nSee <title Reload [Reload] />.\n)'),
      13: tooltip(13, '// #Damage is only a comment\n/* [Reload] */ Plain'),
      14: tooltip(14, '<enhanced/> Better\nimport anti_barrier from global'),
      15: tooltip(15, 'Uses #{Damage}x and #Damage'),
    },
  },
} as unknown as EditorData;

describe('global usages', () => {
  it('lists the tooltips an unedited global is used by, from the loaded data', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    const damage = index.of('g_damage0001');
    // Direct (10, 15), through an import of 12's export that uses the title (11), and through
    // the title's body (12); the commented reference in 13 is not a use.
    expect(damage.tooltips.map((use) => [use.hash, use.direct, use.via]).sort()).toEqual([
      [10, true, []],
      [11, false, ['import Perk from 12']],
      [12, false, ['[Reload]']],
      [15, true, []],
    ]);
    expect(damage.globals).toEqual([
      { id: 'g_title00001', langs: ['en'], direct: true, via: [], line: 1 },
    ]);
    expect(
      index
        .of('g_title00001')
        .tooltips.map((use) => use.hash)
        .sort(),
    ).toEqual([11, 12]);
  });

  it('shows an alias group once under its canonical tooltip, with the member count', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    const rows = index.of('g_damage0001').tooltips.filter((use) => use.hash === 10);
    expect(rows).toEqual([
      { hash: 10, variant: 10, members: 2, langs: ['en'], direct: true, via: [], line: 1 },
    ]);
  });

  it('reads the arrow symbol as the global e and global imports as export uses', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    expect(index.of('g_arrow00001').tooltips.map((use) => use.hash)).toEqual([14]);
    expect(index.of('g_export0001').tooltips.map((use) => [use.hash, use.line])).toEqual([[14, 2]]);
  });
});
