import { expect, test } from 'vitest';
import { langTextSchema, permissionsSchema, pushedSchema, tooltipSchema } from '../src/schemas.js';
import { tooltip } from './helpers.js';

test('minimal Tooltip has no manifest facts or silent unknown fields', () => {
  expect(tooltipSchema.parse(tooltip())).toEqual(tooltip());
  for (const extra of [{ name: 'manifest' }, { itemHash: 3 }, { text: { xx: {} } }]) {
    expect(tooltipSchema.safeParse({ ...tooltip(), ...extra }).success).toBe(false);
  }
});
test('validates hashes, associations, timestamps, custom names and snapshots', () => {
  for (const patch of [{ hash: -1 }, { hash: 2 ** 32 }, { associated: [3, 3] }]) {
    expect(tooltipSchema.safeParse({ ...tooltip(), ...patch }).success).toBe(false);
  }
  expect(langTextSchema.safeParse({ text: '', updatedAt: 'yesterday', updatedBy: '' }).success).toBe(false);
  expect(tooltipSchema.parse({
    ...tooltip(),
    custom: { name: 'Verb', categoryId: 'verbs' },
    compendium: { gid: '123', rowKey: 'Perk', snapshot: { plain: '', runs: [] }, snapshotAt: '2026-01-01T00:00:00Z' },
    bungieSnapshot: { description: '', snapshotAt: '2026-01-01T00:00:00Z' },
  }).custom?.name).toBe('Verb');
  expect(tooltipSchema.safeParse({
    ...tooltip(),
    compendium: { tab: 'Perks', key: 'Perk', column: 'Description', snapshot: '', snapshotAt: '2026-01-01T00:00:00Z' },
  }).success).toBe(false);
});
test('v2 rejects removed stat fields, including nested legacy stat trackers', () => {
  for (const extra of [
    { stats: {} }, { importStatsFrom: 1 }, { duration: [2] }, { activationCondition: 'On hit' },
    { legacy: { updateTracker: { descriptions: {}, stats: { lastUpdate: 0 } } } },
  ]) {
    expect(tooltipSchema.safeParse({ ...tooltip(), ...extra }).success).toBe(false);
  }
});
test('validates permissions and language restrictions', () => {
  expect(permissionsSchema.parse({
    users: { '123': { login: 'alice', role: 'translator', languages: ['de'] } },
  }).users['123'].languages).toEqual(['de']);
  for (const user of [
    { login: 'alice', role: 'admin' },
    { login: 'alice', role: 'translator', languages: ['xx'] },
    { login: '', role: 'editor' },
  ]) expect(permissionsSchema.safeParse({ users: { '123': user } }).success).toBe(false);
  expect(permissionsSchema.safeParse({ users: { alice: { login: 'alice', role: 'editor' } } }).success).toBe(false);
});
test('pushed requires canonical hash keys and SHA-256 values', () => {
  expect(pushedSchema.parse({ '0': 'a'.repeat(64) })).toEqual({ '0': 'a'.repeat(64) });
  for (const value of [{ '01': 'a'.repeat(64) }, { '4294967296': 'a'.repeat(64) }, { '42': 'abc' }]) {
    expect(pushedSchema.safeParse(value).success).toBe(false);
  }
});
