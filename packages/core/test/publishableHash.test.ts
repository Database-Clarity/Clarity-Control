import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { contentHash, stableStringify } from '../src/contentHash.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { publishableHash } from '../src/publishableHash.js';
import { usesEnglishFallback } from '../src/exportLegacy.js';
import { exportCanonical, fixture, tooltip } from './helpers.js';

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

test('a stale translation hashes as the English text it exports, and flips are visible', async () => {
  const stamp = '2026-10-01T00:00:00Z';
  const base = tooltip();
  const build = (sourceUpdatedAt: string) => ({
    ...base,
    text: {
      en: { text: 'English', updatedAt: stamp, updatedBy: 'a' },
      de: { text: 'Deutsch', updatedAt: stamp, updatedBy: 'd', sourceUpdatedAt },
    },
  });
  const fresh = await publishableHash(build(stamp));
  const stale = await publishableHash(build('2026-01-01T00:00:00Z'));
  expect(stale).not.toBe(fresh);
  // Under fallback the German words no longer matter to what is exported or hashed.
  const edited = build('2026-01-01T00:00:00Z');
  edited.text.de.text = 'Anders';
  expect(await publishableHash(edited)).toBe(stale);
  // Unchanged data without any fallback keeps its pre-fallback digest shape.
  expect(await publishableHash(build(stamp))).toBe(
    createHash('sha256')
      .update(
        stableStringify({
          text: { en: 'English', de: 'Deutsch' },
          associated: [],
          custom: undefined,
        }),
      )
      .digest('hex'),
  );
});

test('an English edit followed by a revert changes the digest when it flips a stale translation', async () => {
  const build = (englishUpdatedAt: string, translationSource: string) => ({
    ...tooltip(),
    text: {
      en: { text: 'English A', updatedAt: englishUpdatedAt, updatedBy: 'a' },
      de: {
        text: 'Deutsch A',
        updatedAt: '2026-01-01T00:00:00Z',
        updatedBy: 'd',
        sourceUpdatedAt: translationSource,
      },
    },
  });
  // Source revision 2026-01-01; English re-stamped on 2026-11-03 by edit B -> revert A (same text).
  const before = await publishableHash(build('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'));
  const reverted = await publishableHash(build('2026-11-03T00:00:00Z', '2026-01-01T00:00:00Z'));
  expect(reverted).not.toBe(before);
  // Within 90 days nothing flips, so the re-stamp alone stays invisible to the digest.
  const near = await publishableHash(build('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'));
  expect(near).toBe(before);
});

test('blank English never replaces a translation and is not a fallback', async () => {
  const value = {
    ...tooltip(),
    text: {
      en: { text: '  ', updatedAt: '2026-11-03T00:00:00Z', updatedBy: 'a' },
      de: {
        text: 'Deutsch',
        updatedAt: '2026-01-01T00:00:00Z',
        updatedBy: 'd',
        sourceUpdatedAt: '2026-01-01T00:00:00Z',
      },
    },
  };
  expect(usesEnglishFallback(value, 'de')).toBe(false);
  const entry = exportCanonical([value], 0)['42']!;
  expect(entry.editor.de?.main).toBe('Deutsch');
  expect(await publishableHash(value)).toBe(
    await publishableHash({
      ...value,
      text: { ...value.text, en: { ...value.text.en, updatedAt: '2026-01-02T00:00:00Z' } },
    }),
  );
});

test('incoming aliases are part of the digest, sorted, and absent aliases leave it unchanged', async () => {
  const value = tooltip();
  const plain = await publishableHash(value);
  expect(await publishableHash(value, {})).toBe(plain);
  expect(await publishableHash(value, { 7: { to: 99, kind: 'frame' } })).toBe(plain);
  const one = await publishableHash(value, { 7: { to: 42, kind: 'frame' } });
  expect(one).not.toBe(plain);
  const two = await publishableHash(value, {
    9: { to: 7, kind: 'sandbox' },
    7: { to: 42, kind: 'frame' },
  });
  expect(two).not.toBe(one);
  expect(
    await publishableHash(value, { 7: { to: 42, kind: 'frame' }, 9: { to: 7, kind: 'sandbox' } }),
  ).toBe(two);
  expect(await publishableHash(value, { 7: { to: 42, kind: 'sandbox' } })).not.toBe(one);
});

test('digesting thousands of tooltips against thousands of aliases stays linear', async () => {
  const aliases: Record<string, { to: number; kind: 'frame' | 'sandbox' }> = {};
  for (let index = 0; index < 3000; index++) {
    aliases[10_000 + index] = { to: index % 2900, kind: 'frame' };
  }
  const run = async (withAliases: boolean) => {
    const started = performance.now();
    for (let hash = 0; hash < 2900; hash++) {
      await publishableHash({ ...tooltip(), hash }, withAliases ? aliases : {});
    }
    return performance.now() - started;
  };
  await run(false);
  const plain = await run(false);
  const indexed = await run(true);
  // A scan of every alias per tooltip was ~60x the plain cost; the index adds a small constant.
  expect(indexed).toBeLessThan(plain * 15 + 300);
});

test('hashes the legacy form of the text: delimited spellings are not a change', async () => {
  const base = tooltip();
  const withText = (text: string) => ({ ...base, text: { en: { ...base.text.en!, text } } });
  const plain = await publishableHash(withText('#e Deals #d damage.'));
  expect(await publishableHash(withText('<enhanced/> Deals #{d} damage.'))).toBe(plain);
  // Text without delimited forms hashes exactly as before (the raw text is the legacy form).
  expect(plain).toBe(
    createHash('sha256')
      .update(stableStringify({ text: { en: '#e Deals #d damage.' }, associated: [] }))
      .digest('hex'),
  );
  // A form followed by a word gets a holder variable: a different legacy text, so a change.
  expect(await publishableHash(withText('<enhanced/>2 Stacks'))).not.toBe(
    await publishableHash(withText('#e2 Stacks')),
  );
});
