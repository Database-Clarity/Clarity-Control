import { expect, it } from 'vitest';
import {
  classifyPublishIntent,
  publishBodySchema,
  publishMonth,
  publishIntentDigest,
  validatePublishBody,
} from '../src/publishRequest.js';
import {
  parseScopedPublishRequestPayload,
  parseTranslationPublishBody,
  scopedPublishRequestIntentDigest,
  translationPublishIntentDigest,
  type TranslationPublishIntent,
} from '../src/translationPublishRequest.js';

const opId = '01K95H00000000000000000001';
const body = { opId, hashes: [123], expected: { 123: 'a'.repeat(64) } };
const time = [...opId.slice(0, 10)].reduce(
  (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
  0,
);
it('strictly bounds paths, body, mandatory expectations, and creation time', () => {
  expect(validatePublishBody(body, time)).toEqual(body);
  expect(publishMonth(opId)).toBe(new Date(time).toISOString().slice(0, 7));
  for (const invalid of [
    { ...body, opId: '../bad' },
    { ...body, hashes: [123, 123] },
    { ...body, hashes: [4294967296] },
    { ...body, expected: {} },
    { ...body, expected: { '0123': 'a'.repeat(64) } },
    { ...body, expected: { 123: 'a'.repeat(64), 456: 'a'.repeat(64) } },
    { ...body, repo: 'untrusted' },
    { ...body, hashes: Array.from({ length: 3001 }, (_, i) => i) },
  ])
    expect(publishBodySchema.safeParse(invalid).success).toBe(false);
  expect(() => validatePublishBody(body, time + 86400001)).toThrow('creation window');
  expect(() => validatePublishBody(body, time + 86400001, false)).not.toThrow();
  expect(() => validatePublishBody({ junk: 'x'.repeat(300 * 1024) }, time)).toThrow('300 KB');
});
it('intent digest excludes server clock/login and binds every intent field', async () => {
  const intent = {
    ...body,
    kind: 'push' as const,
    repo: 'owner/repo',
    dataBranch: 'data',
    liveBranch: 'live',
    requester: { id: 1, login: 'alice' },
  };
  const digest = await publishIntentDigest(intent);
  expect(await publishIntentDigest({ ...intent, requester: { id: 1, login: 'renamed' } })).toBe(
    digest,
  );
  for (const changed of [
    { repo: 'other/repo' },
    { dataBranch: 'other' },
    { liveBranch: 'other' },
    { requester: { id: 2, login: 'alice' } },
    { expected: { 123: 'b'.repeat(64) } },
    { opId: '01K95H00000000000000000002' },
    { hashes: [456] },
  ]) {
    expect(await publishIntentDigest({ ...intent, ...changed })).not.toBe(digest);
  }
  expect(
    classifyPublishIntent(
      digest,
      { intentDigest: digest },
      { intentDigest: digest, result: 'done' },
    ),
  ).toEqual({ status: 'complete', result: 'done' });
  expect(
    classifyPublishIntent(digest, undefined, { intentDigest: 'other', result: 'done' }),
  ).toEqual({ status: 'conflict' });
});

const scoped: TranslationPublishIntent = {
  opId,
  kind: 'push',
  repo: 'owner/repo',
  dataBranch: 'data',
  liveBranch: 'live',
  requester: { id: 1, login: 'alice' },
  scope: 'translations',
  rows: [
    {
      kind: 'tooltip',
      hash: 123,
      lang: 'de',
      expected: 'a'.repeat(64),
      english: 'b'.repeat(64),
      before: 'c'.repeat(64),
      effects: 'd'.repeat(64),
    },
    {
      kind: 'global',
      id: 'g_abcdefghij',
      lang: 'fr',
      expected: 'a'.repeat(64),
      english: 'b'.repeat(64),
      before: 'c'.repeat(64),
      effects: 'd'.repeat(64),
      affected: 'e'.repeat(64),
    },
  ],
};

it('checks the scoped HTTP and signed push shapes, including LIVE alias roots', async () => {
  const scopedBody = { opId, scope: scoped.scope, rows: scoped.rows };
  expect(parseTranslationPublishBody(scopedBody, {})).toEqual(scopedBody);
  const [tooltip, global] = scoped.rows;
  const aliases = { 123: { to: 456, kind: 'frame' as const } };
  expect(() => parseTranslationPublishBody(scopedBody, aliases)).toThrow(/alias/);
  const signed = {
    ...scoped,
    createdAt: new Date(time).toISOString(),
    intentDigest: await translationPublishIntentDigest(scoped),
  };
  expect(await parseScopedPublishRequestPayload(signed, {})).toEqual(signed);
  await expect(parseScopedPublishRequestPayload(signed, aliases)).rejects.toThrow(/alias/);
  for (const rows of [
    [],
    [tooltip, tooltip],
    [global, { ...global, before: 'f'.repeat(64) }],
    [{ ...tooltip, lang: 'en' }],
    [{ ...global, lang: 'en' }],
    [{ ...tooltip, lang: 'DE' }],
    [{ ...tooltip, hash: 1 }],
    [{ ...tooltip, hash: 2 }],
    [{ ...tooltip, hash: 3 }],
    [{ ...global, affected: undefined }],
    [{ ...tooltip, unreviewed: true }],
    [{ ...tooltip, kind: 'other' }],
  ]) {
    expect(() => parseTranslationPublishBody({ ...scopedBody, rows }, {})).toThrow();
    await expect(parseScopedPublishRequestPayload({ ...signed, rows }, {})).rejects.toThrow();
  }
  for (const extra of [{ hashes: [123] }, { expected: {} }, { globals: [] }, { typo: true }]) {
    expect(() => parseTranslationPublishBody({ ...scopedBody, ...extra }, {})).toThrow();
    await expect(parseScopedPublishRequestPayload({ ...signed, ...extra }, {})).rejects.toThrow();
  }
  expect(() =>
    parseTranslationPublishBody({ ...scopedBody, requester: scoped.requester }, {}),
  ).toThrow();
  await expect(
    parseScopedPublishRequestPayload({ ...signed, kind: 'batch' }, {}),
  ).rejects.toThrow();
});

it('canonicalizes scoped row and key order and binds each reviewed fact', async () => {
  const [tooltip, global] = scoped.rows;
  const digest = await translationPublishIntentDigest(scoped);
  const reversed = Object.fromEntries(Object.entries(tooltip).reverse());
  expect(
    await translationPublishIntentDigest({
      ...scoped,
      rows: [global, reversed as typeof tooltip],
      requester: { id: 1, login: 'renamed' },
    }),
  ).toBe(digest);
  for (const key of ['expected', 'english', 'before', 'effects', 'affected'] as const) {
    expect(
      await translationPublishIntentDigest({
        ...scoped,
        rows: [tooltip, { ...global, [key]: '9'.repeat(64) }],
      }),
    ).not.toBe(digest);
  }
  expect(
    await translationPublishIntentDigest({
      ...scoped,
      requester: { id: 2, login: 'alice' },
    }),
  ).not.toBe(digest);
});

it('keeps the recorded ordinary global-push digest through the scoped-aware dispatcher', async () => {
  const ordinary = {
    ...body,
    kind: scoped.kind,
    repo: scoped.repo,
    dataBranch: scoped.dataBranch,
    liveBranch: scoped.liveBranch,
    requester: scoped.requester,
    globals: [
      { id: 'g_zyxwvutsr', expected: 'd'.repeat(64) },
      { id: 'g_abcdefghi', expected: 'c'.repeat(64) },
    ],
    createdAt: new Date(time).toISOString(),
    intentDigest: 'd1527fbf1b5c78a5b40c67629acf41894027fe28df2827141b97788621b9a742',
  };
  const parsed = await parseScopedPublishRequestPayload(ordinary, {});
  expect(parsed).toEqual(ordinary);
  expect(await scopedPublishRequestIntentDigest(parsed)).toBe(ordinary.intentDigest);
});
