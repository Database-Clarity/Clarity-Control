import { expect, test } from 'vitest';
import {
  affectedAliasCanonicals,
  aliasGroupFactsDigest,
  aliasGroupArchiveSchema,
  aliasGroupOperationSchema,
  aliasGroupsRequestSchema,
  aliasGroupsResponseSchema,
  aliasGroupsSchema,
  composeAliases,
  effectiveAliases,
  emptyAliasGroups,
  exportLegacy,
  mergeSandboxPointers,
  migrateLegacy,
  parseMarkup,
  publishableHash,
  resolveAlias,
  activeAliases,
  type AliasGroups,
  type AliasItems,
  type SandboxPointers,
} from '../src/index.js';
import { database, tooltip } from './helpers.js';

const head = 'a'.repeat(40),
  factsDigest = 'b'.repeat(64);
const by = { id: '1', login: 'maintainer' },
  at = '2026-11-15T00:00:00Z';
const items: AliasItems = Object.fromEntries(
  [42, 43, 44].map((hash) => [
    hash,
    {
      hash,
      name: 'Perk',
      categoryId: 'weapon-trait',
      plugCategoryHash: 20,
      inGameDescription: 'Same in-game text',
    },
  ]),
);
const group = (canonical = 42): AliasGroups => ({
  version: 1,
  rejected: {},
  groups: {
    [canonical]: {
      members: [42, 43, 44],
      kind: 'S',
      basis: { name: 'Perk', categoryId: 'weapon-trait' },
      by,
      at,
    },
  },
});
const pointers: SandboxPointers = {
  version: 1,
  pointers: {
    90: { to: 43, candidates: [43, 99], by: 1, at },
    91: { none: true, candidates: [42, 99], by: 1, at },
    92: { state: 'undone', by: 1, at },
  },
};
const conflicts = { 90: [43, 99], 91: [42, 99], 92: [42, 99] };
const accept = { op: 'accept', canonical: 42, members: [42, 43], factsDigest };

test('rejection digest is membership/facts-bound and independent of input order', async () => {
  const digest = await aliasGroupFactsDigest([42, 43], items);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(await aliasGroupFactsDigest([43, 42], items)).toBe(digest);
  expect(await aliasGroupFactsDigest([42, 44], items)).not.toBe(digest);
  for (const patch of [
    { name: 'Renamed' },
    { inGameDescription: 'Changed' },
    { isEnhanced: true },
    { exotic: true },
    { baseHash: 44 },
    { plugCategoryHash: 21 },
    { owners: [100] },
  ]) {
    expect(
      await aliasGroupFactsDigest([42, 43], { ...items, 43: { ...items[43]!, ...patch } }),
    ).not.toBe(digest);
  }
  await expect(aliasGroupFactsDigest([42, 99], items)).rejects.toThrow('Missing alias facts');
  await expect(aliasGroupFactsDigest([42, 42], items)).rejects.toThrow();
});

test('strict operations admit only client intent, bounded CAS batches, and selected canonicals', () => {
  for (const op of [
    accept,
    { ...accept, op: 'split' },
    { op: 'reject', members: [42, 43], factsDigest },
    { op: 'ungroup', canonical: 42 },
    { op: 'setCanonical', canonical: 42, to: 43 },
  ]) {
    expect(aliasGroupOperationSchema.parse(op)).toEqual(op);
    expect(aliasGroupsRequestSchema.parse({ expectedHead: head, ops: [op] }).ops).toEqual([op]);
  }
  for (const patch of [
    { by },
    { at },
    { bulkEligible: true },
    { kind: 'X' },
    { basis: {} },
    { archives: [] },
    { canonical: 44 },
    { members: [42, 42] },
    { members: [42] },
    { factsDigest: head },
    { acknowledgeConflicts: false },
  ])
    expect(aliasGroupOperationSchema.safeParse({ ...accept, ...patch }).success).toBe(false);
  for (const ops of [[], Array(101).fill(accept)])
    expect(aliasGroupsRequestSchema.safeParse({ expectedHead: head, ops }).success).toBe(false);
  expect(
    aliasGroupsRequestSchema.parse({ expectedHead: head, ops: Array(100).fill(accept) }).ops,
  ).toHaveLength(100);
  expect(
    aliasGroupsRequestSchema.safeParse({ expectedHead: 'branch', ops: [accept] }).success,
  ).toBe(false);
  expect(
    aliasGroupOperationSchema.safeParse({ op: 'setCanonical', canonical: 42, to: 42 }).success,
  ).toBe(false);
});

test('archives reference original blobs and absence without accepting paths outside the archive', () => {
  const archive = {
    path: `migration-archives/alias-groups/${head}/42.json`,
    files: { 42: head, 43: null },
  };
  expect(aliasGroupArchiveSchema.parse(archive)).toEqual(archive);
  const config = aliasGroupsSchema.parse({ ...group(), archives: [archive] });
  const response = { head, config, issues: [], affectedCanonicals: [42, 43] };
  expect(aliasGroupsResponseSchema.parse(response)).toEqual(response);
  for (const path of [
    'tooltips/42.json',
    `migration-archives/alias-groups/${head}/../42.json`,
    `migration-archives/alias-groups/${head}/4294967296.json`,
  ])
    expect(aliasGroupArchiveSchema.safeParse({ ...archive, path }).success).toBe(false);
  expect(
    aliasGroupArchiveSchema.safeParse({ ...archive, files: { 42: 'reserialized text' } }).success,
  ).toBe(false);
  expect(aliasGroupsSchema.safeParse({ ...config, archives: [archive, archive] }).success).toBe(
    false,
  );
  expect(aliasGroupsResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
});

test('absent groups preserve every sandbox-pick behavior and generated alias identity', () => {
  const generated = { 100: { to: 42, kind: 'sandbox' as const } };
  expect(composeAliases(generated, undefined, {}).aliases).toBe(generated);
  for (const input of [undefined, pointers]) {
    expect(composeAliases(generated, undefined, {}, conflicts, input)).toEqual({
      aliases: mergeSandboxPointers(generated, conflicts, input),
      issues: [],
    });
  }
  expect(composeAliases(generated, emptyAliasGroups(), {}, conflicts, pointers).aliases).toEqual(
    mergeSandboxPointers(generated, conflicts, pointers),
  );
});

test('sandbox targets follow accepted groups, including drifted candidates, and export canonical text', async () => {
  const before = composeAliases({}, undefined, items, conflicts, pointers).aliases;
  const result = composeAliases({}, group(), items, { ...conflicts, 90: [43, 101] }, pointers);
  expect(result.issues).toEqual([]);
  expect(result.aliases).toEqual({
    43: { to: 42, kind: 'name' },
    44: { to: 42, kind: 'name' },
    90: { to: 42, kind: 'sandbox' },
  });
  expect(resolveAlias(90, result.aliases)).toBe(42);
  const value = tooltip();
  value.text.en!.text = 'Canonical text';
  const output = exportLegacy([value], 0, undefined, result.aliases);
  expect(output[90]).toEqual({ hash: 90, aliasOf: 42, aliasKind: 'sandbox' });
  expect(output[42]).toHaveProperty('editor.en.main', 'Canonical text');
  expect(output[43]).not.toHaveProperty('editor');
  expect(affectedAliasCanonicals(before, result.aliases, items)).toEqual([42, 43, 44]);
  expect(await publishableHash(value, result.aliases)).not.toBe(
    await publishableHash(value, before),
  );
  expect(await publishableHash({ ...value, hash: 99 }, result.aliases)).toBe(
    await publishableHash({ ...value, hash: 99 }, before),
  );
  expect(pointers.pointers[90]).toHaveProperty('to', 43); // no mutation of reviewed intent
});

test('inactive moves filter after composition and do not silently rehome an omitted stub', () => {
  const { aliases } = composeAliases({}, group(), items, conflicts, pointers);
  const filtered = activeAliases(aliases, { 90: { by: 1, at } });
  expect(filtered[90]).toBeUndefined();
  expect(filtered[43]).toEqual({ to: 42, kind: 'name' });
  expect(aliases[90]).toEqual({ to: 42, kind: 'sandbox' });
});

test('invalid picks stay invalid; groups cannot claim sandbox identities; cycles and malformed config fail', () => {
  // Generated aliases win, and picks at a generated alias never become active through a group.
  const generated = { 43: { to: 42, kind: 'frame' as const } };
  const result = composeAliases(generated, group(), items, conflicts, pointers);
  expect(result.aliases[43]).toEqual(generated[43]);
  expect(result.aliases[90]).toBeUndefined();
  expect(result.issues).toHaveLength(1);
  const occupied = {
    ...pointers,
    pointers: {
      ...pointers.pointers,
      43: { none: true as const, candidates: [42, 99], by: 1, at },
    },
  };
  expect(composeAliases({}, undefined, items, conflicts, occupied).aliases[90]).toBeUndefined();
  expect(() =>
    composeAliases({}, group(), items, { ...conflicts, 43: [42, 99] }, pointers),
  ).toThrow('shared sandbox identity');
  expect(() =>
    composeAliases(
      { 42: { to: 43, kind: 'frame' }, 43: { to: 42, kind: 'sandbox' } },
      undefined,
      items,
    ),
  ).toThrow('Cyclic');
  expect(() =>
    composeAliases({}, { ...group(), version: 2 } as unknown as AliasGroups, items),
  ).toThrow();
  const overlapping = { ...group(), groups: { ...group().groups, 43: group().groups[42]! } };
  expect(() => composeAliases({}, overlapping, items)).toThrow();
});

test('canonical drift, member deletion, subgroup mismatch, and fake fact identity are rejected', () => {
  for (const patch of [{ name: 'Renamed' }, { categoryId: 'weapon-mod' }]) {
    const result = effectiveAliases(
      {},
      group(),
      Object.fromEntries(Object.entries(items).map(([key, item]) => [key, { ...item, ...patch }])),
    );
    expect(result.aliases).toEqual({});
    expect(result.issues).toHaveLength(1);
  }
  const { 43: removed, ...remaining } = items;
  void removed;
  expect(effectiveAliases({}, group(), remaining).issues).toEqual([
    expect.objectContaining({ member: 43 }),
  ]);
  for (const patch of [
    { categoryId: 'weapon-traitor' },
    { plugCategoryHash: undefined },
    { plugCategoryHash: 21 },
    { isEnhanced: true },
    { exotic: true },
  ]) {
    expect(
      effectiveAliases({}, group(), { ...items, 43: { ...items[43]!, ...patch } }).aliases[43],
    ).toBeUndefined();
  }
  expect(() =>
    effectiveAliases({}, group(), { ...items, 43: { ...items[43]!, hash: 99 } }),
  ).toThrow('fact key');
});

test('subclass copies need identical wording, not identical class plug categories', () => {
  const config = group();
  config.groups[42]!.basis.categoryId = 'subclass-grenade';
  const facts = Object.fromEntries(
    Object.entries(items).map(([key, item]) => [
      key,
      {
        ...item,
        categoryId: 'subclass-grenade',
        plugCategoryHash: item.hash,
      },
    ]),
  );
  expect(effectiveAliases({}, config, facts).issues).toEqual([]);
  facts[43].inGameDescription = 'Different wording';
  expect(effectiveAliases({}, config, facts).issues).toEqual([
    expect.objectContaining({ member: 43 }),
  ]);
});

test('exotic trait groups require proven shared ownership, including multi-owner traits', () => {
  const config = group();
  config.groups[42]!.basis.categoryId = 'weapon-trait-exotic';
  const facts = Object.fromEntries(
    Object.entries(items).map(([key, item]) => [
      key,
      {
        ...item,
        categoryId: 'weapon-trait-exotic',
        exotic: true,
        owners: [100, item.hash],
      },
    ]),
  );
  expect(effectiveAliases({}, config, facts).issues).toEqual([]);
  facts[43].owners = [200];
  expect(effectiveAliases({}, config, facts).aliases).toEqual({});
  const unknown = Object.fromEntries(
    Object.entries(facts).map(([key, item]) => [key, { ...item, owners: undefined }]),
  );
  expect(effectiveAliases({}, config, unknown).aliases).toEqual({});
});

test('recanonicalization and ungroup return both identities, including chained generated dependents', () => {
  const generated = { 80: { to: 43, kind: 'sandbox' as const } };
  const before = composeAliases(generated, group(), items).aliases;
  const after = composeAliases(generated, group(44), items).aliases;
  expect(resolveAlias(80, after)).toBe(44);
  expect(affectedAliasCanonicals(before, after, items)).toEqual([42, 44]);
  expect(affectedAliasCanonicals(after, generated, items)).toEqual([42, 43, 44]);
  expect(affectedAliasCanonicals(after, after, items)).toEqual([]);
});

test('real fixture census exports unchanged when alias group config is absent', () => {
  const source = database('intermediate');
  const tooltips = migrateLegacy(source);
  expect(tooltips).toHaveLength(2761);
  const aliases = composeAliases({}, undefined, {}).aliases;
  expect(exportLegacy(tooltips, 0, undefined, aliases)).toEqual(exportLegacy(tooltips, 0));
});

test('real markup resolver reads nested alias imports and detects cycles and deleted imports', () => {
  const { aliases } = composeAliases({}, group(), items, conflicts, pointers);
  const text = { 42: 'Canonical body', 60: 'import main from 90', 61: 'import main from 61' };
  const imports = Object.fromEntries(
    Object.keys({ ...text, ...aliases }).map((hash) => [
      hash,
      text[resolveAlias(Number(hash), aliases) as keyof typeof text] ?? '',
    ]),
  );
  const globals = { variables: '', titles: '', imports };
  expect(parseMarkup('import main from 60', globals)).toEqual(
    parseMarkup('Canonical body', globals),
  );
  expect(parseMarkup('import main from 61', globals).diagnostics).toEqual([
    expect.objectContaining({ severity: 'error', message: expect.stringContaining('cycle') }),
  ]);
  expect(parseMarkup('import main from 999', globals).diagnostics).toEqual([
    expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining('Unresolved import'),
    }),
  ]);
});
