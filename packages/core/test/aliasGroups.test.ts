import { expect, test } from 'vitest';
import {
  aliasGroupsSchema,
  effectiveAliases,
  aliasCanonicalHash,
  aliasVariantHashes,
  enhancedWordingNeeded,
  readAliasProposals,
  readPossibleEnhanced,
  exportLegacy,
  publishableHash,
  type AliasItems,
} from '../src/index.js';
import { tooltip } from './helpers.js';
const items: AliasItems = {
  42: {
    hash: 42,
    name: 'Perk',
    categoryId: 'weapon-trait',
    plugCategoryHash: 20,
    inGameDescription: 'Base',
  },
  43: {
    hash: 43,
    name: 'Perk',
    categoryId: 'weapon-trait',
    plugCategoryHash: 20,
    inGameDescription: 'Base',
  },
  50: {
    hash: 50,
    name: 'Perk',
    categoryId: 'weapon-trait-enhanced',
    plugCategoryHash: 20,
    isEnhanced: true,
    baseHash: 42,
    inGameDescription: 'Longer',
  },
  51: {
    hash: 51,
    name: 'Perk',
    categoryId: 'weapon-trait-enhanced',
    plugCategoryHash: 20,
    isEnhanced: true,
    baseHash: 43,
    inGameDescription: 'Longer',
  },
};
const group = (members: number[]) => ({
  members,
  kind: 'S' as const,
  basis: { name: 'Perk', categoryId: 'weapon-trait' },
  by: { id: '1', login: 'owner' },
  at: '2026-11-03T00:00:00Z',
});
const config = (
  groups: Record<string, ReturnType<typeof group>> = {
    '42': group([42, 43]),
    '50': group([50, 51]),
  },
) => aliasGroupsSchema.parse({ version: 1, groups, rejected: {} });
test('groups resolve enhanced members across base groups; unaccepted enhanced groups retain pending variants', () => {
  const { aliases } = effectiveAliases({}, config(), items);
  expect(aliasCanonicalHash(51, items, aliases)).toBe(42);
  expect(aliasVariantHashes(42, items, aliases)).toEqual([42, 50]);
  const pending = effectiveAliases({}, config({ '42': group([42, 43]) }), items).aliases;
  expect(aliasCanonicalHash(51, items, pending)).toBe(42);
  expect(aliasVariantHashes(42, items, pending)).toEqual([42, 50, 51]);
  expect(enhancedWordingNeeded(items, aliases, {})).toEqual([
    { baseHash: 42, enhancedHashes: [50] },
  ]);
  const value = tooltip();
  value.text.en!.text = 'enhanced (\nLonger\n)';
  expect(enhancedWordingNeeded(items, aliases, { 42: value })).toEqual([]);
  // An enhanced weapon part with different in-game wording still needs no wording of its own.
  const parts: AliasItems = {
    60: { hash: 60, name: 'Part', categoryId: 'weapon-perk', inGameDescription: 'Base' },
    61: {
      hash: 61,
      name: 'Part',
      categoryId: 'weapon-perk-enhanced',
      baseHash: 60,
      inGameDescription: 'Longer',
    },
  };
  expect(enhancedWordingNeeded(parts, {}, {})).toEqual([]);
});
test('generated precedence is flagged, groups drop and flag mixed enhanced/exotic/frame and multiple base owners', () => {
  const result = effectiveAliases(
    { 43: { to: 42, kind: 'sandbox' } },
    config({ '42': group([42, 43]) }),
    items,
  );
  expect(result.aliases[43]?.kind).toBe('sandbox');
  expect(result.issues).toHaveLength(1);
  for (const patch of [
    { categoryId: 'weapon-trait-exotic' },
    { isEnhanced: true },
    { categoryId: 'weapon-frame' },
  ]) {
    const drifted = effectiveAliases({}, config({ '42': group([42, 43]) }), {
      ...items,
      43: { ...items[43]!, ...patch },
    });
    expect(drifted.aliases).toEqual({});
    expect(drifted.issues).toEqual([expect.objectContaining({ canonical: 42, member: 43 })]);
  }
  const splitBases = effectiveAliases({}, config({ '50': group([50, 51]) }), items);
  expect(splitBases.aliases).toEqual({});
  expect(splitBases.issues).toEqual([expect.objectContaining({ canonical: 50, member: 51 })]);
  expect(() =>
    aliasGroupsSchema.parse({
      version: 1,
      groups: { 42: group([42, 43]), 50: group([43, 50]) },
      rejected: {},
    }),
  ).toThrow();
  expect(() =>
    aliasCanonicalHash(42, { ...items, 42: { ...items[42]!, baseHash: 50 } }, {}),
  ).toThrow('Cyclic');
});
test('name aliases export stubs with own facts and affect only their canonical publish digest', async () => {
  const aliases = effectiveAliases({}, config({ '42': group([42, 43]) }), items).aliases;
  const value = tooltip();
  expect(await publishableHash(value, aliases)).not.toBe(await publishableHash(value));
  const other = { ...value, hash: 99 };
  expect(await publishableHash(other, aliases)).toBe(await publishableHash(other));
  expect(exportLegacy([value], 0, undefined, aliases)[43]).toEqual({
    hash: 43,
    aliasOf: 42,
    aliasKind: 'name',
  });
});
test('proposal reader validates facts, prevents bulk wording/conflicts and derives enhanced-markup twins', () => {
  const proposal = {
    kind: 'S',
    canonical: 42,
    members: [42, 43],
    basis: { name: 'Perk', categoryId: 'weapon-trait', isEnhanced: false, exotic: false },
    descriptionDiff: 'identical',
    statsDiff: false,
    weapons: {},
  };
  const read = (p: object, values = {}) =>
    readAliasProposals({ version: 1, proposals: [p] }, values)[0]!;
  expect(read(proposal).bulkEligible).toBe(true);
  expect(read({ ...proposal, descriptionDiff: 'wording' }).bulkEligible).toBe(false);
  const a = tooltip(),
    b = { ...tooltip(), hash: 43, text: { en: { ...tooltip().text.en!, text: 'Different' } } };
  expect(read(proposal, { 42: a, 43: b }).textState).toBe('conflict');
  a.text.en!.text = 'enhanced (\nText\n)';
  expect(read({ ...proposal, kind: 'X' }, { 42: a }).action).toBe('derive');
  expect(() => read({ ...proposal, kind: 'invalid' })).toThrow();
});

test('in-group imports are text references rather than conflicts and choose the owner', () => {
  const a = tooltip(),
    b = { ...tooltip(), hash: 43 };
  b.text = { en: { ...a.text.en!, text: 'import main from 42' } };
  const input = {
    version: 1,
    proposals: [
      {
        kind: 'S',
        canonical: 43,
        members: [42, 43],
        basis: { name: 'Perk', categoryId: 'weapon-trait', isEnhanced: false, exotic: false },
        descriptionDiff: 'identical',
        statsDiff: false,
        weapons: {},
      },
    ],
  };
  expect(readAliasProposals(input, { 42: a, 43: b })[0]).toMatchObject({
    canonical: 42,
    textState: 'one text',
    bulkEligible: true,
  });
});

test('manifest drift removes only affected edges and preserves unrelated groups', () => {
  for (const patch of [
    { name: 'Renamed' },
    { categoryId: 'weapon-mod' },
    { plugCategoryHash: 21 },
    { plugCategoryHash: undefined },
    { isEnhanced: true },
  ]) {
    const result = effectiveAliases({}, config(), { ...items, 43: { ...items[43]!, ...patch } });
    expect(result.aliases).toEqual({});
    expect(result.issues).toHaveLength(2); // base member and its enhanced counterpart
    expect(result.issues.map((i) => i.member).sort()).toEqual([43, 51]);
  }
  const { 43: removed, ...remaining } = items;
  void removed;
  expect(
    effectiveAliases({}, config(), remaining)
      .issues.map((i) => i.member)
      .sort(),
  ).toEqual([43, 51]);
  const { 42: missingCanonical, ...others } = items;
  void missingCanonical;
  const result = effectiveAliases({}, config(), others);
  expect(result.aliases).toEqual({});
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ canonical: 42 }),
      expect.objectContaining({ canonical: 50, member: 51 }),
    ]),
  );
  const unaffected = effectiveAliases({}, config(), {
    ...items,
    51: { ...items[51]!, name: 'Renamed' },
  });
  expect(unaffected.aliases).toEqual({ 43: { to: 42, kind: 'name' } });
  expect(unaffected.issues).toHaveLength(1);
});

test('exotic numbered frames alias to their unnumbered canonical only within its actual owner', () => {
  const facts: AliasItems = {
    1: {
      hash: 1,
      name: 'Frame',
      categoryId: 'weapon-frame-exotic',
      itemHash: 100,
      plugCategoryHash: 20,
      inGameDescription: 'Same',
    },
    2: {
      hash: 2,
      name: 'Frame II',
      categoryId: 'weapon-frame-exotic',
      itemHash: 100,
      plugCategoryHash: 20,
      inGameDescription: 'Same',
    },
    3: {
      hash: 3,
      name: 'Frame III',
      categoryId: 'weapon-frame-exotic',
      itemHash: 200,
      plugCategoryHash: 20,
      inGameDescription: 'Same',
    },
    4: {
      hash: 4,
      name: 'Frame IV',
      categoryId: 'weapon-frame',
      itemHash: 100,
      plugCategoryHash: 20,
      inGameDescription: 'Same',
    },
  };
  const decision = aliasGroupsSchema.parse({
    version: 1,
    rejected: {},
    groups: {
      1: {
        ...group([1, 2, 3, 4]),
        basis: { name: 'Frame', categoryId: 'weapon-frame-exotic', exoticFrameOwner: 100 },
      },
    },
  });
  const result = effectiveAliases({}, decision, facts);
  expect(result.aliases).toEqual({ 2: { to: 1, kind: 'name' } });
  expect(result.issues.map((i) => i.member)).toEqual([3, 4]);
  expect(aliasCanonicalHash(2, facts, result.aliases)).toBe(1);
  const text = { ...tooltip(), hash: 2 };
  expect(
    readAliasProposals(
      {
        version: 1,
        proposals: [
          {
            kind: 'S',
            canonical: 1,
            members: [1, 2],
            basis: {
              name: 'Frame',
              categoryId: 'weapon-frame-exotic',
              isEnhanced: false,
              exotic: true,
              exoticFrameOwner: 100,
            },
            descriptionDiff: 'identical',
            statsDiff: true,
            weapons: {},
          },
        ],
      },
      { 2: text },
    )[0]?.canonical,
  ).toBe(1);
  expect(
    enhancedWordingNeeded(
      {
        ...facts,
        2: { ...facts[2]!, baseHash: 1, isEnhanced: true, inGameDescription: 'Different' },
      },
      {},
      {},
    ),
  ).toEqual([]);
});
test('persisted Kind X requires identical wording and DIM provenance', () => {
  const decision = aliasGroupsSchema.parse({
    version: 1,
    rejected: {},
    groups: { 42: { ...group([42, 43]), kind: 'X' } },
  });
  expect(
    effectiveAliases({}, decision, { ...items, 43: { ...items[43]!, dimBaseHash: 42 } }).aliases[43]
      ?.to,
  ).toBe(42);
  expect(
    effectiveAliases({}, decision, {
      ...items,
      43: { ...items[43]!, dimBaseHash: 42, inGameDescription: 'Longer' },
    }).aliases,
  ).toEqual({});
});

test('possible enhanced pairs stay separate from alias proposals and require a maintainer call', () => {
  const possibleEnhanced = [
    { baseHash: 42, variantHash: 43, reason: 'possible enhanced — maintainer call' },
  ];
  const input = { version: 1, proposals: [], possibleEnhanced };
  expect(readPossibleEnhanced(input)).toEqual(possibleEnhanced);
  expect(readAliasProposals(input, {})).toEqual([]);
  expect(readPossibleEnhanced({ version: 1, proposals: [] })).toEqual([]);
  expect(() =>
    readPossibleEnhanced({
      ...input,
      possibleEnhanced: [{ ...possibleEnhanced[0], reason: 'alias' }],
    }),
  ).toThrow();
});

test('notification fallback facts route to the base and enhanced wording queue without an isEnhanced flag', () => {
  const base = { ...items[42]!, name: 'Accelerated Assault', categoryId: 'weapon-trait-origin' };
  const variant = {
    ...base,
    hash: 43,
    categoryId: 'weapon-trait-origin-enhanced',
    baseHash: 42,
    inGameDescription: 'Further increases reload speed.',
  };
  const facts = { 42: base, 43: variant };
  expect(aliasCanonicalHash(43, facts, {})).toBe(42);
  expect(enhancedWordingNeeded(facts, {}, {})).toEqual([{ baseHash: 42, enhancedHashes: [43] }]);
  expect(readPossibleEnhanced({ version: 1, proposals: [], possibleEnhanced: [] })).toEqual([]);
});

test('accepted duplicate bases preserve enhanced membership in older catalogs without a pointer', () => {
  const facts = { ...items, 51: { ...items[51]!, baseHash: undefined } };
  const accepted = effectiveAliases({}, config(), facts);
  expect(accepted.issues).toEqual([]);
  expect(accepted.aliases[51]).toEqual({ to: 50, kind: 'name' });
  const pending = effectiveAliases({}, config({ 50: group([50, 51]) }), facts);
  expect(pending.aliases[51]).toBeUndefined();
  expect(pending.issues).toHaveLength(1);
});

test('enhanced legendary frames retain the generated canonical across weapon types', () => {
  const base = { ...items[42]!, categoryId: 'weapon-frame', name: 'Aggressive Frame' };
  const facts = {
    42: base,
    43: { ...base, hash: 43, inGameDescription: 'Different weapon frame' },
    50: { ...base, hash: 50, categoryId: 'weapon-frame-enhanced', baseHash: 42 },
    51: { ...base, hash: 51, categoryId: 'weapon-frame-exotic' },
  };
  const generated = {
    43: { to: 42, kind: 'frame' as const },
    50: { to: 42, kind: 'frame' as const },
  };
  const result = effectiveAliases(generated, { version: 1, groups: {}, rejected: {} }, facts);
  expect(result.issues).toEqual([]);
  expect(aliasCanonicalHash(50, facts, result.aliases)).toBe(42);
  expect(aliasCanonicalHash(43, facts, result.aliases)).toBe(42);
  expect(aliasCanonicalHash(51, facts, result.aliases)).toBe(51);
});
