import { expect, test } from 'vitest';
import {
  composeAliases,
  exportLegacy,
  mergeLivePerks,
  type AliasGroups,
  type AliasItems,
  type Tooltip,
} from '../../core/src/index.js';
import {
  buildLegacy,
  compile,
  legacyPresets,
  newStyleFile,
  type LegacyInput,
} from '../src/index.js';
import { editorDataInput, expected, sha256 } from './helpers.js';

const at = '2026-11-15T00:00:00Z';
const item = (hash: number, categoryId = 'weapon-trait', extra = {}): AliasItems[string] => ({
  hash,
  name: 'Perk',
  categoryId,
  inGameDescription: 'Description',
  plugCategoryHash: 20,
  ...extra,
});
const items: AliasItems = {
  100: item(100),
  101: item(101),
  110: item(110, 'weapon-trait-enhanced', { isEnhanced: true, baseHash: 100 }),
  111: item(111, 'weapon-trait-enhanced', { isEnhanced: true, baseHash: 101 }),
  200: item(200, 'weapon-frame-exotic', { name: 'Exotic', itemHash: 900 }),
  201: item(201, 'weapon-frame-exotic', { name: 'Exotic II', itemHash: 900 }),
  202: item(202, 'weapon-frame-exotic', { name: 'Exotic III', owners: [900] }),
  203: item(203, 'weapon-frame-exotic', { name: 'Exotic IV', itemHash: 900 }),
};
const groups: AliasGroups = {
  version: 1,
  rejected: {},
  groups: Object.fromEntries(
    [
      [100, 101],
      [110, 111],
      [200, 201, 202, 203],
    ].map((members) => {
      const canonical = items[members[0]!]!;
      return [
        canonical.hash,
        {
          members,
          kind: 'S',
          by: { id: '1', login: 'owner' },
          at,
          basis: {
            name: canonical.name,
            categoryId: canonical.categoryId,
            ...(canonical.hash === 200 ? { exoticFrameOwner: 900 } : {}),
          },
        },
      ];
    }),
  ),
  archives: [
    {
      path: `migration-archives/alias-groups/${'a'.repeat(40)}/100.json`,
      files: { 101: 'b'.repeat(40) },
    },
  ],
};
const tooltip = (hash: number, en: string, de = en): Tooltip => ({
  hash,
  associated: [],
  text: {
    en: { text: en, updatedAt: at, updatedBy: 'alice' },
    de: { text: de, updatedAt: at, updatedBy: 'bob' },
  },
});
const catalog = Object.fromEntries(
  Object.values(items).map((i) => [
    i.hash,
    {
      name: i.name,
      type:
        i.categoryId === 'weapon-frame-exotic'
          ? 'Weapon Frame Exotic'
          : i.isEnhanced
            ? 'Weapon Trait Enhanced'
            : 'Weapon Trait',
      ...(i.itemHash === undefined ? {} : { itemHash: i.itemHash, itemName: 'Weapon' }),
    },
  ]),
);
const aliases = {
  ...composeAliases({}, groups, items).aliases,
  700: { to: 100, kind: 'sandbox' as const },
};
const input = (): LegacyInput => ({
  perks: exportLegacy(
    [
      tooltip(1, 'export Shared (\nGlobal body\n)', 'export Shared (\nGlobal deutsch\n)'),
      tooltip(2, 'var C = 5'),
      tooltip(3, 'title Help (\nHelp text\n)'),
      tooltip(
        100,
        '<bold Base /> #C\nimport Shared from global',
        '<bold Basis /> #C\nimport Shared from global',
      ),
      tooltip(110, 'Enhanced <arrow/>'),
      tooltip(200, 'Exotic body'),
      tooltip(300, 'import main from 101', 'import main from 101'),
    ],
    0,
    {
      ...catalog,
      1: { name: 'Globals', type: 'none' },
      2: { name: 'Variables', type: 'none' },
      3: { name: 'Titles', type: 'none' },
      300: { name: 'Nested', type: 'Weapon Trait' },
    },
    aliases,
  ) as LegacyInput['perks'],
});

test.each(legacyPresets)(
  '%s publishes accepted name aliases with own facts, translations, and imports',
  (preset) => {
    const source = input();
    const output = JSON.parse(new TextDecoder().decode(buildLegacy(source, preset)));
    for (const [hash, canonical] of [
      [101, 100],
      [111, 110],
      [201, 200],
      [202, 200],
      [203, 200],
    ]) {
      if (preset === 'clarityV2') expect(output[hash]).toEqual({ hash, aliasOf: canonical });
      else {
        expect(output[hash].descriptions).toEqual(output[canonical].descriptions);
        if (output[hash].name !== undefined) expect(output[hash].name).toBe(items[hash]!.name);
      }
    }
    if (preset !== 'clarityV2') {
      expect(output).not.toHaveProperty('700');
      expect(output[300].descriptions).toEqual(output[100].descriptions);
      if (preset !== 'vaultZero') expect(output[101].descriptions).toHaveProperty('de');
    }
    expect(JSON.stringify(output)).not.toMatch(/migration-archives|archives|aliasKind/);
  },
);

test('v1 uses a name alias own category and facts, with frame and sandbox toggles disabled', () => {
  const file = newStyleFile('aliases', 'plain', {
    categories: ['weapon-trait', 'weapon-trait-enhanced', 'weapon-frame-exotic'],
    sandboxPerks: [],
    frameAliases: false,
    languages: ['en', 'de'],
    keys: ['name'],
    bungieIdentical: false,
  });
  const source = input();
  const catalog = {
    items: { ...items, 300: item(300) },
    categories: file.data.categories.map((id) => ({ id })),
  };
  const plan = compile(source, file, { catalog });
  expect(plan.expanded![101]!.descriptions).toEqual(plan.expanded![100]!.descriptions);
  expect(plan.expanded![201]!.name).toBe('Exotic II');
  expect(plan.expanded).not.toHaveProperty('700');
  const onlyEnhanced = compile(
    source,
    { ...file, data: { ...file.data, categories: ['weapon-trait-enhanced'] } },
    { catalog },
  );
  expect(Object.keys(onlyEnhanced.expanded!)).toEqual(['110', '111']);
  expect(JSON.stringify(plan.file)).not.toContain('migration-archives');
});

test('v1 refuses cyclic and deleted imports through name aliases using the real resolver', () => {
  const file = newStyleFile('aliases', 'plain', {
    categories: ['weapon-trait'], languages: ['en'], sandboxPerks: [],
  });
  const source = input();
  const catalog = { items: { ...items, 300: item(300) }, categories: [{id:'weapon-trait'}] };
  const canonical = source.perks[100]!;
  if ('aliasOf' in canonical) throw new Error('Expected canonical');
  canonical.editor.en!.main = 'import main from 300';
  expect(() => compile(source, file, { catalog })).toThrow(/cycl|recurs/i);
  delete source.perks[100];
  expect(() => compile(source, file, { catalog })).toThrow(/Invalid alias/);
});

test.each(legacyPresets)(
  'real absent-config census preserves %s bytes and every hash',
  (preset) => {
    const { input, identical } = editorDataInput();
    const merged = { ...input, perks: mergeLivePerks(input.perks, {}) as LegacyInput['perks'] };
    const bytes = buildLegacy(merged, preset, { identical });
    expect(sha256(bytes)).toBe(expected.editorData.files[preset]);
    expect(Object.keys(merged.perks)).toEqual(Object.keys(input.perks));
    // A consumer-only counterfactual over actual fixture rows, not adoption proposals: replace
    // identical, nonempty, same-name/type rows with name stubs. Group eligibility is S1's job.
    const candidates = new Map<string, number[]>();
    for (const row of Object.values(input.perks)) {
      if (
        'aliasOf' in row ||
        row.hash < 50 ||
        !row.editor.en?.main.trim() ||
        !/^(Weapon (Trait|Perk)|Armor Mod|Subclass)/.test(row.type) ||
        row.type.includes('Exotic')
      )
        continue;
      const key = JSON.stringify([row.name, row.type, row.editor]);
      const members = candidates.get(key) ?? [];
      members.push(row.hash);
      candidates.set(key, members);
    }
    const aliases: Record<string, number> = {};
    const grouped = structuredClone(input);
    for (const members of candidates.values()) {
      const [canonical, ...rest] = members;
      for (const hash of rest) {
        const row = input.perks[hash]!;
        if ('aliasOf' in row) throw new Error('Expected an authored fixture row');
        aliases[hash] = canonical!;
        grouped.perks[hash] = {
          hash,
          aliasOf: canonical!,
          aliasKind: 'name',
          name: row.name,
          type: row.type,
          ...(row.itemHash === undefined ? {} : { itemHash: row.itemHash, itemName: row.itemName }),
        };
      }
    }
    const retargetedAliases: string[] = [];
    for (const [hash, row] of Object.entries(grouped.perks)) {
      if ('aliasOf' in row && aliases[row.aliasOf] !== undefined) {
        row.aliasOf = aliases[row.aliasOf]!;
        retargetedAliases.push(hash);
      } else if (!('aliasOf' in row) && row.associated)
        row.associated = [...new Set(row.associated.map((hash) => aliases[hash] ?? hash))].filter(
          (hash) => hash !== row.hash,
        );
    }
    const after = buildLegacy(grouped, preset, { identical });
    const beforeRows = JSON.parse(new TextDecoder().decode(bytes));
    const afterRows = JSON.parse(new TextDecoder().decode(after));
    const changedHashes = [
      ...new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)]),
    ].filter((hash) => JSON.stringify(beforeRows[hash]) !== JSON.stringify(afterRows[hash]));
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    for (const hash of changedHashes)
      expect([...Object.keys(aliases), ...retargetedAliases]).toContain(hash);
    console.info(
      JSON.stringify({
        preset,
        records: Object.keys(input.perks).length,
        fixtureOnlyAliasHashes: Object.keys(aliases),
        retargetedAliases,
        changedHashes,
        absentConfigSha256: sha256(bytes),
        groupedSha256: sha256(after),
        absentConfigBytes: bytes.length,
        groupedBytes: after.length,
      }),
    );
  },
  120_000,
);
