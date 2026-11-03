import { expect, test } from 'vitest';
import {
  aliasGroupsSchema,
  effectiveAliases,
  aliasCanonicalHash,
  aliasVariantHashes,
  enhancedWordingNeeded,
  readAliasProposals,
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
});
test('generated precedence is flagged, groups reject mixed enhanced/exotic/frame and multiple base owners', () => {
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
    expect(() =>
      effectiveAliases({}, config({ '42': group([42, 43]) }), {
        ...items,
        43: { ...items[43]!, ...patch },
      }),
    ).toThrow();
  }
  expect(() => effectiveAliases({}, config({ '50': group([50, 51]) }), items)).toThrow(
    'multiple base',
  );
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
