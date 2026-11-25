import { expect, it } from 'vitest';
import fixture from './contract.fixture.json';
import { globalStoreSchema, validGlobalName } from './model.js';
import { globalImpactSchema } from './impactModel.js';
import { inventoryGlobals } from './projection.js';
import { assertGlobalTransition } from './transition.js';

it('freezes strict portable storage and impact fixtures', () => {
  expect(globalStoreSchema.parse(fixture.store)).toEqual(fixture.store);
  expect(globalImpactSchema.parse(fixture.impact)).toEqual(fixture.impact);
  expect(globalStoreSchema.safeParse({ ...fixture.store, surprise: true }).success).toBe(false);
});

it('accepts a new post-migration entry without provenance', () => {
  const created = structuredClone(fixture.store);
  Reflect.deleteProperty(created.entries[0].definitions.en, 'provenance');
  expect(globalStoreSchema.parse(created)).toEqual(created);
  const store = globalStoreSchema.parse(created);
  expect(() => assertGlobalTransition(store, store, {})).not.toThrow();
});

it('inventory always emits provenance', () => {
  const store = inventoryGlobals(
    [
      {
        hash: 2,
        associated: [],
        text: {
          en: { text: 'var damage = 10', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' },
        },
      },
    ],
    {
      repository: 'editor-data',
      revision: 'source1',
      locate: (hash, lang) => ({ path: `tooltips/${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => 'g_fixture0001',
  );
  expect(store.entries).toHaveLength(1);
  expect(store.entries[0].definitions.en?.provenance).toMatchObject({
    repository: 'editor-data',
    revision: 'source1',
    hash: 2,
    lang: 'en',
  });
});

it('rejects a transition that removes migration provenance', () => {
  const after = structuredClone(fixture.store);
  after.entries[0].revision = 'r2';
  after.entries[0].definitions.en.revision = 'r2';
  Reflect.deleteProperty(after.entries[0].definitions.en, 'provenance');
  expect(() =>
    assertGlobalTransition(
      globalStoreSchema.parse(fixture.store),
      globalStoreSchema.parse(after),
      {},
    ),
  ).toThrow('Migration ancestry is immutable');
});

it('rejects duplicate identities/names and unrepresentable title names', () => {
  const duplicate = structuredClone(fixture.store);
  duplicate.entries.push({ ...duplicate.entries[0] });
  expect(globalStoreSchema.safeParse(duplicate).success).toBe(false);
  duplicate.entries[1].id = 'g_fixture0002';
  expect(globalStoreSchema.safeParse(duplicate).success).toBe(false);
  expect(validGlobalName('titles', 'Solar Info')).toBe(true);
  expect(validGlobalName('titles', 'Subtitle')).toBe(false);
  expect(validGlobalName('titles', 'A[B')).toBe(false);
  expect(validGlobalName('titles', 'A]B')).toBe(false);
  expect(validGlobalName('variables', 'damage_2')).toBe(false);
});
