import { describe, expect, it } from 'vitest';
import type { GlobalRecord, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { buildGlobalUsageIndex, globalUsageIndex } from './usages';

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
const item = (hash: number, extra = {}) => ({
  hash,
  name: `Item ${hash}`,
  icon: '',
  categoryId: 'perk',
  ...extra,
});

const entries = [
  entry('g_damage0001', 'variables', 'Damage', '10%'),
  entry('g_arrow00001', 'variables', 'e', '🡅'),
  entry('g_nativeA001', 'variables', 'A', '{{#B}{other}}'),
  entry('g_nativeB001', 'variables', 'B', 'bee'),
  entry('g_title00001', 'titles', 'Reload', 'Reloads by #Damage.'),
  entry('g_export0001', 'exports', 'anti_barrier', 'Pierces shields.'),
];
const chain = Object.fromEntries(
  [30, 31, 32, 33, 34, 35].map((hash) => [hash, tooltip(hash, `import main from ${hash + 1}`)]),
);
const data = {
  categories: [],
  items: {
    ...Object.fromEntries([10, 11, 12, 13, 14, 15, 16, 17, 20, 40, 51].map((h) => [h, item(h)])),
    50: item(50, { baseHash: 51 }),
  },
  aliases: { 20: { to: 10, kind: 'sandbox' } },
  bundle: {
    tooltips: {
      10: tooltip(10, 'Deals #Damage more.'),
      11: tooltip(11, 'Intro\nimport Perk from 12'),
      12: tooltip(12, 'export Perk (\nSee <title Reload [Reload] />.\n)'),
      13: tooltip(13, '// #Damage is only a comment\n/* [Reload] */ Plain'),
      14: tooltip(14, '<enhanced/> Better\nimport anti_barrier from global'),
      15: tooltip(15, 'Uses #{Damage}x and #Damage'),
      16: tooltip(16, '<link #Damage [https://example.com] />'),
      17: tooltip(17, '#A'),
      ...chain,
      36: tooltip(36, '#Damage'),
      40: tooltip(40, '/*\nimport main from 10\n*/ Text'),
      // An override (50) listed under its base (51); only the base writes the reference.
      50: tooltip(50, 'import main from 51\nvar pve = 410\nmore'),
      51: tooltip(51, 'One\nTwo\n#Damage'),
    },
  },
} as unknown as EditorData;
const hashes = (uses: { hash: number }[]) => uses.map((use) => use.hash).sort((a, b) => a - b);

describe('global usages, observed from the resolver', () => {
  it('lists the tooltips an unedited global is used by, direct and through what renders it', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    const damage = index.of('g_damage0001').tooltips;
    const row = (hash: number) => damage.find((use) => use.hash === hash);
    // 13 only mentions it in comments; 40's import is inside a block comment; 30 needs six
    // import passes (the resolver stops at five) while 31 needs five.
    expect(hashes(damage)).toEqual([10, 11, 12, 15, 16, 31, 32, 33, 34, 35, 36, 51]);
    expect(row(10)).toMatchObject({ direct: true, via: [] });
    // A link label renders the value: it is written there.
    expect(row(16)).toMatchObject({ direct: true });
    expect(row(12)).toMatchObject({ direct: false, via: ['[Reload]'] });
    expect(row(11)).toMatchObject({ direct: false, via: ['import Perk from 12'] });
    expect(index.of('g_damage0001').globals).toEqual([
      { id: 'g_title00001', langs: ['en'], direct: true, via: [] },
    ]);
    expect(hashes(index.of('g_title00001').tooltips)).toEqual([11, 12]);
  });

  it('follows a variable whose value is a native pair into the variable it renders', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    expect(index.of('g_nativeB001').tooltips).toMatchObject([
      { hash: 17, direct: false, via: ['#A'] },
    ]);
    expect(index.of('g_nativeB001').globals).toMatchObject([{ id: 'g_nativeA001', direct: true }]);
  });

  it('shows an alias group once, and opens the member and line of the written use', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    const damage = index.of('g_damage0001').tooltips;
    expect(damage.filter((use) => use.hash === 10)).toEqual([
      {
        hash: 10,
        open: { variant: 10, lang: 'en', line: 1 },
        members: 2,
        langs: ['en'],
        direct: true,
        via: [],
      },
    ]);
    // The override (50) is met first and only imports; the row still opens the base's line 3.
    expect(damage.find((use) => use.hash === 51)).toMatchObject({
      open: { variant: 51, lang: 'en', line: 3 },
      members: 2,
      direct: true,
    });
  });

  it('reads the arrow symbol as the global e and global imports as export uses', async () => {
    const index = await buildGlobalUsageIndex(data, entries);
    expect(hashes(index.of('g_arrow00001').tooltips)).toEqual([14]);
    expect(index.of('g_export0001').tooltips).toMatchObject([
      { hash: 14, direct: true, open: { line: 2 } },
    ]);
  });
});

it('reuses one index per data and catalogue content, so reopening a global never rebuilds it', () => {
  const first = globalUsageIndex(data, entries);
  expect(globalUsageIndex(data, structuredClone(entries))).toBe(first);
  const renamed = entries.map((item) =>
    item.id === 'g_damage0001' ? { ...item, name: 'Harm' } : item,
  );
  expect(globalUsageIndex(data, renamed)).not.toBe(first);
});

describe('global usages the resolver reaches through math and nested imports', () => {
  const n = entry('g_number0001', 'variables', 'N', '10');
  const nested = [
    n,
    entry('g_wrapped001', 'exports', 'Wrapped', 'import Payload from 42'),
    entry('g_detail0001', 'titles', 'Detail', 'import Payload from 42'),
  ];
  const german = tooltip(63, 'Plain');
  german.text.de = { text: 'Mit #N', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' };
  const nestedData = {
    categories: [],
    items: Object.fromEntries([42, 60, 61, 62, 63].map((hash) => [hash, item(hash)])),
    aliases: {},
    bundle: {
      tooltips: {
        42: tooltip(42, 'export Payload (\n#N\n)'),
        60: tooltip(60, 'Math: ${#N*2}'),
        61: tooltip(61, 'import Wrapped from global'),
        62: tooltip(62, '<title Details [Detail] />'),
        63: german,
      },
    },
  } as unknown as EditorData;

  it('counts math, an export or title body that imports, and a translation-only use', async () => {
    const index = await buildGlobalUsageIndex(nestedData, nested);
    const uses = index.of(n.id).tooltips;
    const row = (hash: number) => uses.find((use) => use.hash === hash);
    expect(hashes(uses)).toEqual([42, 60, 61, 62, 63]);
    expect(row(60)).toMatchObject({ direct: true, open: { line: 1 } });
    expect(row(61)).toMatchObject({ direct: false, via: ['import Wrapped from global'] });
    expect(row(62)).toMatchObject({ direct: false, via: ['[Detail]'] });
    // Used only in German: German is the language listed, and the row opens there.
    expect(row(63)).toMatchObject({ langs: ['de'], direct: true, open: { lang: 'de', line: 1 } });
    expect(index.of(n.id).globals.map((use) => [use.id, use.direct, use.via])).toEqual([
      ['g_wrapped001', false, ['import Payload from 42']],
      ['g_detail0001', false, ['import Payload from 42']],
    ]);
  });
});
