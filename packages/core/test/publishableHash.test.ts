import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { contentHash, stableStringify } from '../src/contentHash.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { publishableHash } from '../src/publishableHash.js';
import { fixture, tooltip } from './helpers.js';

test('hashes exactly the canonical publishable projection with SHA-256', async () => {
  const value = {
    ...tooltip(),
    associated: [9, 2],
    custom: { name: 'Global', categoryId: 'global' },
  };
  const projection = {
    text: { en: 'English' },
    associated: [9, 2],
    custom: value.custom,
  };
  expect(await publishableHash(value)).toBe(
    createHash('sha256').update(stableStringify(projection)).digest('hex'),
  );
  expect(await publishableHash(value)).toMatch(/^[a-f0-9]{64}$/);
  expect(value.associated).toEqual([9, 2]);
  expect(await publishableHash({ ...value, hash: 123 })).toBe(await publishableHash(value));
  expect(await publishableHash({ ...value, associated: [2, 9] })).not.toBe(
    await publishableHash(value),
  );
});

test('empty and single-element associations hash as before order became meaningful', async () => {
  expect(await publishableHash({ ...tooltip(), associated: [] })).toBe(
    '09fa9ede78e8f168f8af688400e361410594c2354f86326d42b51a500e3ca5f5',
  );
  expect(await publishableHash({ ...tooltip(), associated: [7] })).toBe(
    '9d66270fbda993433760873e242a296354a6085769bc62b05502cbc383c7a3cb',
  );
});

test('all edit, source, legacy and snapshot metadata is excluded without mutating it', async () => {
  const original = tooltip();
  const changed = {
    ...original,
    text: {
      en: {
        text: 'English',
        updatedAt: '2026-02-01T00:00:00.000Z',
        updatedBy: 'bob',
        sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    legacy: {
      uploadedBy: 'publisher',
      lastUpload: 1000,
      inLiveDatabase: true,
      uploadToLive: false,
      updateTracker: { descriptions: { en: { lastUpdate: 2000, updatedBy: 'old author' } } },
    },
    compendium: {
      gid: '1662574278',
      rowKey: 'Example',
      snapshot: { plain: 'cell', runs: [{ text: 'cell' }] },
      snapshotAt: '2026-02-01T00:00:00.000Z',
    },
    bungieSnapshot: { description: 'Bungie', snapshotAt: '2026-02-01T00:00:00.000Z' },
  };
  const before = structuredClone(changed);
  expect(await contentHash(changed)).not.toBe(await contentHash(original));
  expect(await publishableHash(changed)).toBe(await publishableHash(original));
  expect(changed).toEqual(before);
});

test('text, language presence, associations and custom facts each affect publication', async () => {
  const original = tooltip();
  const hash = await publishableHash(original);
  const variants = [
    { ...original, text: { en: { ...original.text.en!, text: 'Edited' } } },
    { ...original, text: { ...original.text, de: { ...original.text.en!, text: 'Deutsch' } } },
    { ...original, text: {} },
    { ...original, associated: [99] },
    { ...original, custom: { name: 'Custom', categoryId: 'verbs' } },
    { ...original, custom: { name: 'Custom', categoryId: 'globals' } },
  ];
  for (const variant of variants) expect(await publishableHash(variant)).not.toBe(hash);
  expect(await publishableHash(variants[4])).not.toBe(await publishableHash(variants[5]));
});

test('rejects invalid tooltips even when an invalid field is not publishable', async () => {
  await expect(publishableHash({ ...tooltip(), hash: -1 })).rejects.toThrow();
  await expect(publishableHash({ ...tooltip(), associated: [1, 1] })).rejects.toThrow();
});

test('real legacy sources have only 12 publishable differences, not 2761 metadata differences', async () => {
  const intermediate = migrateLegacy(fixture('intermediate'));
  const live = migrateLegacy(fixture('live'));
  const pushed = new Map(
    await Promise.all(
      live.map(async (value) => [value.hash, await publishableHash(value)] as const),
    ),
  );
  const pending = await Promise.all(
    intermediate.map(async (value) => (await publishableHash(value)) !== pushed.get(value.hash)),
  );
  expect(intermediate).toHaveLength(2761);
  expect(pending.filter(Boolean)).toHaveLength(12);
});
