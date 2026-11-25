import { expect, it } from 'vitest';
import type { Aliases } from '../src/aliases.js';
import { exportLegacy } from '../src/exportLegacy.js';
import type { GlobalRecord } from '../src/globals/model.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { publishableHash } from '../src/publishableHash.js';
import type { LangText, Tooltip } from '../src/schemas.js';
import {
  composeGlobalTranslation,
  composeTooltipTranslation,
  translationAffectedDigest,
  translationBeforeDigest,
  translationEnglishDigest,
  translationEnglishGate,
  translationExpectedDigest,
  translationFallbackIds,
  verifyTranslationPublishTree,
  type TranslationEnglishGateInput,
} from '../src/translationPublish.js';
import { database, tooltip } from './helpers.js';

const live = tooltip();
const en = live.text.en!;
const de: LangText = { ...en, text: 'Deutsch', sourceUpdatedAt: en.updatedAt };
const fr: LangText = { ...en, text: 'Français', sourceUpdatedAt: en.updatedAt };
const newRevision = { ...en, updatedAt: '2026-02-01T00:00:00.000Z' };
const withEnglish = (entry?: LangText): Tooltip => ({ ...live, text: entry ? { en: entry } : {} });
const active = { status: 'active', entry: live } as const;
const tooltipGate = (
  saved: Tooltip,
  published: Extract<TranslationEnglishGateInput, { kind: 'tooltip' }>['live'] = active,
  liveAliases: Aliases = {},
) =>
  translationEnglishGate({ kind: 'tooltip', hash: live.hash, saved, live: published, liveAliases });

it.each<[string, Tooltip, typeof active?]>([
  ['kept revision, changed words', withEnglish({ ...en, text: 'Edited wording' })],
  [
    'markup-only',
    withEnglish({ ...en, text: '<solar Scorch />' }),
    {
      status: 'active',
      entry: withEnglish({ ...en, text: '<solar/>Scorch' }),
    },
  ],
  ['other language', { ...live, text: { en, fr } }],
  ['associations', { ...live, associated: [55] }],
  [
    'pending Inactive move',
    {
      ...live,
      archive: {
        removedAt: en.updatedAt,
        lastSeen: { name: 'Real name', categoryId: 'perk', manifestVersion: 'pinned' },
      },
    },
  ],
])('is ready with %s', (_label, saved, published) => {
  expect(tooltipGate(saved, published)).toEqual({ status: 'ready' });
});

it.each([
  ['new tooltip', withEnglish(en), { status: 'missing' }, 'missing-live'],
  ['unverified source', withEnglish(en), { status: 'unverified' }, 'unverified-live'],
  [
    'words changed',
    withEnglish({ ...newRevision, text: 'Different wording' }),
    active,
    'english-pending',
  ],
  [
    'numbers changed',
    withEnglish({ ...newRevision, text: 'Damage 12%' }),
    {
      status: 'active',
      entry: withEnglish({ ...en, text: 'Damage 10%' }),
    },
    'english-pending',
  ],
  ['author changed', withEnglish({ ...en, updatedBy: 'someone-else' }), active, 'english-pending'],
  ['English added', withEnglish(en), { status: 'active', entry: withEnglish() }, 'english-pending'],
  ['English removed', withEnglish(), active, 'english-pending'],
  ['link-only', withEnglish(), { status: 'active', entry: withEnglish() }, 'missing-live-english'],
] as const)('waits with %s', (_label, saved, published, reason) => {
  expect(tooltipGate(saved, published)).toEqual({ status: 'waiting', reason });
});

it('refuses inactive targets and aliases', () => {
  expect(tooltipGate(live, { status: 'inactive' })).toEqual({
    status: 'refused',
    reason: 'inactive',
  });
  expect(tooltipGate(live, active, { [live.hash]: { to: 99, kind: 'frame' } })).toEqual({
    status: 'refused',
    reason: 'alias-root',
  });
  expect(
    translationEnglishGate({
      kind: 'tooltip',
      hash: 3,
      saved: undefined,
      live: { status: 'missing' },
      liveAliases: {},
    }),
  ).toEqual({ status: 'refused', reason: 'reserved-tooltip' });
});

it('uses the English definition revision on the stable global ID across a pending rename', () => {
  const english = {
    body: en.text,
    updatedAt: en.updatedAt,
    updatedBy: en.updatedBy,
    revision: 'v1',
  };
  const record: GlobalRecord = {
    version: 1,
    id: 'g_fixture001',
    kind: 'variables',
    name: 'OldName',
    revision: 'r1',
    nameHistory: [],
    definitions: { en: english, fr: { ...english, body: fr.text } },
  };
  const saved = { ...record, name: 'NewName', revision: 'r2' };
  const gate = (entry: GlobalRecord) =>
    translationEnglishGate({
      kind: 'global',
      id: record.id,
      saved: entry,
      live: { status: 'active', entry: record },
    });
  expect(gate(saved)).toEqual({ status: 'ready' });
  expect(
    gate({
      ...saved,
      definitions: { en: { ...english, revision: 'v2', body: 'Edited' } },
    }),
  ).toEqual({ status: 'waiting', reason: 'english-pending' });
  expect(gate({ ...saved, definitions: {} })).toEqual({
    status: 'waiting',
    reason: 'english-pending',
  });
  const german = { ...english, body: de.text, revision: 'de1', sourceRevision: 'v1' };
  const next = composeGlobalTranslation(record, 'de', german);
  expect(next).toEqual({ ...record, definitions: { ...record.definitions, de: german } });
  expect(composeGlobalTranslation(next, 'de', undefined)).toEqual(record);
});

it('preserves unselected authored bytes across the real intermediate corpus', async () => {
  const corpus = migrateLegacy(database('intermediate')).filter(
    ({ hash, text }) => hash > 3 && text.en?.text.trim(),
  );
  expect(corpus.length).toBeGreaterThan(1700);
  const liveAliases: Aliases = {
    2566539: { to: 1260401931, kind: 'sandbox' },
    378204240: { to: 1316753551, kind: 'frame' },
  };
  for (const source of corpus) {
    if (Object.hasOwn(liveAliases, source.hash)) continue;
    const published = { ...source, text: { ...source.text, fr } };
    const originalBytes = JSON.stringify(published);
    const german = { ...de, sourceUpdatedAt: source.text.en!.updatedAt };
    const result = await composeTooltipTranslation(published, 'de', german, [], liveAliases);
    const { de: selected, ...unselected } = result.tooltip.text;
    expect(selected).toEqual(german);
    expect(JSON.stringify({ ...result.tooltip, text: unselected })).toBe(originalBytes);
    expect(JSON.stringify(published)).toBe(originalBytes);
    expect(result.marker).toBe(await publishableHash(result.tooltip, liveAliases));
  }
});

it('touches only the selected fallback bits and preserves the ordinary next publish', async () => {
  const english = {
    ...en,
    text: 'Damage 10%',
    numbers: {
      ids: [1],
      next: 4,
      retired: {
        2: { value: '5%', fallback: ['fr', 'de'] as const, variables: { rate: '5%' } },
        3: { value: '2%', fallback: ['fr'] as const },
      },
    },
  };
  const published: Tooltip = {
    ...live,
    text: {
      en: {
        ...english,
        numbers: {
          ...english.numbers,
          retired: {
            2: { ...english.numbers.retired[2], fallback: ['fr', 'de'] },
            3: { ...english.numbers.retired[3], fallback: ['fr'] },
          },
        },
      },
      fr,
    },
  };
  const aliases: Aliases = { 43: { to: live.hash, kind: 'frame' } };
  const result = await composeTooltipTranslation(published, 'de', de, [], aliases);
  expect(result.tooltip).toEqual({
    ...published,
    text: {
      en: {
        ...english,
        numbers: {
          ...english.numbers,
          retired: {
            ...english.numbers.retired,
            2: { ...english.numbers.retired[2], fallback: ['fr'] },
          },
        },
      },
      fr,
      de,
    },
  });
  expect(translationFallbackIds(result.tooltip.text.en, 'fr')).toEqual([2, 3]);
  expect(await translationEnglishDigest(result.tooltip.text.en!)).toBe(
    await translationEnglishDigest(published.text.en!),
  );
  expect(await translationBeforeDigest(de, [])).not.toBe(await translationBeforeDigest(de, [2]));
  expect(await translationExpectedDigest(de)).not.toBe(await translationExpectedDigest(undefined));
  expect(await translationExpectedDigest(de)).not.toBe(
    await translationExpectedDigest({ ...de, updatedBy: 'new-translator' }),
  );
  expect(await composeTooltipTranslation(result.tooltip, 'de', de, [], aliases)).toEqual(result);
  const restamped = await composeTooltipTranslation(
    result.tooltip,
    'de',
    { ...de, updatedBy: 'different translator' },
    [],
    aliases,
  );
  expect(restamped.marker).toBe(result.marker);
  expect(restamped.tooltip.text.de?.updatedBy).toBe('different translator');
  const withdrawn = await composeTooltipTranslation(result.tooltip, 'de', undefined, [], aliases);
  expect(withdrawn.tooltip.text.de).toBeUndefined();
  expect(withdrawn.tooltip.text.fr).toEqual(fr);
  expect(withdrawn.marker).toBe(await publishableHash(withdrawn.tooltip, aliases));
  await expect(composeTooltipTranslation(published, 'de', de, [4], aliases)).rejects.toThrow(
    'no published fallback binding',
  );
  const current = {
    ...result.tooltip,
    associated: [55],
    text: { fr: { ...fr, text: 'Nouveau' }, de, en: { ...newRevision, text: 'Damage 20%' } },
  };
  expect(result.marker).not.toBe(await publishableHash(current, aliases));
  const ordinary = await publishableHash(current, {});
  expect(ordinary).not.toBe(await publishableHash(current, aliases));
  expect(await publishableHash(current)).toBe(ordinary);
  const output = exportLegacy([current], Date.parse(newRevision.updatedAt), undefined, aliases);
  expect(output[live.hash]).toMatchObject({
    associated: [55],
    editor: {
      en: { main: 'Damage 20%' },
      de: { main: de.text },
      fr: { main: 'Nouveau' },
    },
  });
  expect(output[43]).toEqual({ hash: 43, aliasOf: live.hash, aliasKind: 'frame' });
});

it('compares exact blob maps against independently reconstructed allowed values', async () => {
  const before = { kept: 'a', changed: 'b', removed: 'c' };
  const after = { kept: 'a', changed: 'd', added: 'e' };
  const allowed = new Map([
    ['changed', 'd'],
    ['added', 'e'],
    ['removed', null],
  ]);
  expect(verifyTranslationPublishTree(before, after, allowed)).toEqual({ ok: true });
  expect(verifyTranslationPublishTree(before, { ...after, changed: 'wrong' }, allowed)).toEqual({
    ok: false,
    path: 'changed',
  });
  expect(verifyTranslationPublishTree(before, { ...after, kept: 'wrong' }, allowed)).toEqual({
    ok: false,
    path: 'kept',
  });
  expect(verifyTranslationPublishTree(before, { ...after, extra: 'wrong' }, allowed)).toEqual({
    ok: false,
    path: 'extra',
  });
  expect(verifyTranslationPublishTree(before, { ...after, removed: 'c' }, allowed)).toEqual({
    ok: false,
    path: 'removed',
  });
  expect(await translationAffectedDigest([22, 11, 22])).toBe(
    await translationAffectedDigest([11, 22]),
  );
});
