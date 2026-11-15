import { expect, it } from 'vitest';
import fixture from './contract.fixture.json';
import { globalStoreSchema, globalReviewSchema, validGlobalName } from './model.js';
import { globalImpactSchema } from './impactModel.js';

it('freezes strict portable storage, review, and impact fixtures', () => {
  expect(globalStoreSchema.parse(fixture.store)).toEqual(fixture.store);
  expect(globalReviewSchema.parse(fixture.review)).toEqual(fixture.review);
  expect(globalImpactSchema.parse(fixture.impact)).toEqual(fixture.impact);
  expect(globalStoreSchema.safeParse({ ...fixture.store, surprise: true }).success).toBe(false);
  const missing = structuredClone(fixture.store);
  Reflect.deleteProperty(missing.entries[0].definitions.en, 'provenance');
  expect(globalStoreSchema.safeParse(missing).success).toBe(false);
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
