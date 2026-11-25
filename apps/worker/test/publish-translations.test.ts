import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  globalsInPlaceCapability,
  globalsInPlacePath,
  globalsInPlacePublishContract,
  globalsReleasePaths,
  publishMonth,
  publishableHash,
  translationBeforeDigest,
  translationEnglishDigest,
  translationExpectedDigest,
  translationPublishCapability,
  translationPublishContract,
  translationPublishIntentDigest,
  translationPublishPayloadSchema,
  type GlobalRecord,
  type Tooltip,
  type TranslationPublishBody,
  type TranslationPublishRow,
} from '@clarity/core';
import { schedulePaths } from '@clarity/core/schedule';
import { blobOid, config, Fixture, makePrivateKey, sha, tooltip } from './fixture.js';
import { translationPartRows } from '../src/translationPublish.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: true } }));

const A = '01K95H00000000000000000001';
const B = '01K95H00000000000000000002';
const requestPath = (opId: string) => `publish/requests/${opId}.json`;
const logPath = (opId: string) => `publish/log/${publishMonth(opId)}/${opId}.json`;
const rootPath = 'live/translation-roots.json';
const route = `/publish?contract=${translationPublishContract}`;
const statusPath = (opId: string) =>
  `/publish/status?opId=${opId}&contract=${translationPublishContract}`;
const me = `/me?contract=${translationPublishContract}`;
const permissionFixture = {
  users: {
    ...config.users,
    '5': { login: 'fr-manager', role: 'translator', languages: ['fr'], manages: ['fr'] },
    '6': { login: 'another-de', role: 'translator', languages: ['de'] },
    '7': { login: 'de-manager', role: 'translator', languages: ['de'], manages: ['de'] },
  },
  partners: { '8': { login: 'partner', projects: ['example'] } },
};
const now = [...A.slice(0, 10)].reduce(
  (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
  0,
);
const stored = (hash = 123, live = tooltip()): Tooltip => ({
  ...live,
  hash,
  text: {
    ...live.text,
    de: {
      text: 'Gespeicherte Beschreibung',
      updatedAt: '2026-10-02T00:00:00Z',
      updatedBy: 'dan',
      sourceUpdatedAt: live.text.en!.updatedAt,
    },
  },
});

async function tuple(saved: Tooltip, live: Tooltip): Promise<TranslationPublishRow> {
  return {
    kind: 'tooltip',
    hash: saved.hash,
    lang: 'de',
    expected: await translationExpectedDigest(saved.text.de),
    english: await translationEnglishDigest(live.text.en!),
    before: await translationBeforeDigest(live.text.de),
    effects: 'e'.repeat(64),
  };
}

let appKey: string;
let f: Fixture;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const live = tooltip();
const saved = stored();
let value: TranslationPublishBody;
const send = (data: unknown = value, id = 4) => f.request(route, 'POST', data, id);
const status = (id = 4, opId = A) => f.request(statusPath(opId), 'GET', undefined, id);
const kick = (id = 4, opId = A) => f.request('/publish/kick', 'POST', { opId }, id);
const replaceRow = (change: Record<string, unknown>) => ({
  ...value,
  rows: [{ ...value.rows[0], ...change }],
});
const envelope = (opId = A) => f.current()[requestPath(opId)] as { payload: string; sig: string };
const readiness = () => ({
  '.publisher/PIN': { capabilities: [globalsInPlaceCapability, translationPublishCapability] },
  [globalsInPlacePath]: {
    destination: f.env.LIVE_BRANCH,
    legacyData: sha(225),
    legacyLive: sha(226),
    migratedLive: sha(227),
    state: 'active',
  },
  [rootPath]: {
    destination: f.env.LIVE_BRANCH,
    liveCommit: f.liveHead,
    roots: { 123: blobOid(live) },
  },
});

beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now });
  f = new Fixture(appKey);
  f.env.PUBLISH_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  f.env.TRANSLATION_PUBLISH = '1';
  f.moveData({
    ...readiness(),
    'config/permissions.json': permissionFixture,
    'tooltips/123.json': saved,
    'live/tooltips/123.json': live,
  });
  value = { opId: A, scope: 'translations', rows: [await tuple(saved, live)] };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('signs just the selected translation intent and gets its facts in one snapshot', async () => {
  const response = await send();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ opId: A, status: 'pending' });
  const { payload, sig } = envelope();
  expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(sig, 'base64'))).toBe(true);
  const parsed = translationPublishPayloadSchema.parse(JSON.parse(payload));
  expect(parsed).toMatchObject({
    ...value,
    kind: 'push',
    requester: { id: 4 },
    liveBranch: f.env.LIVE_BRANCH,
  });
  expect(parsed.intentDigest).toBe(await translationPublishIntentDigest(parsed));
  expect(f.graphqlCalls).toBe(1);
  expect(f.subrequests).toBeLessThan(10);
});

it('negotiates capability only for compatible clients, eligible roles, and active destinations', async () => {
  expect(await (await f.request(me, 'GET', undefined, 4)).json()).toHaveProperty(
    'translationPublish',
    { version: translationPublishContract, partRows: translationPartRows },
  );
  expect(await (await f.request('/me', 'GET', undefined, 4)).json()).not.toHaveProperty(
    'translationPublish',
  );
  expect(await (await f.request(me, 'GET', undefined, 3)).json()).not.toHaveProperty(
    'translationPublish',
  );
  expect((await f.request('/publish', 'POST', value, 4)).status).toBe(409);
  expect((await f.request(`${route}&contract=other`, 'POST', value, 4)).status).toBe(409);
  delete f.env.TRANSLATION_PUBLISH;
  expect((await send()).status).toBe(503);
  expect(await (await f.request(me, 'GET', undefined, 4)).json()).not.toHaveProperty(
    'translationPublish',
  );
  f.env.TRANSLATION_PUBLISH = '1';
  for (const update of [
    { '.publisher/PIN': { capabilities: [globalsInPlaceCapability] } },
    { [rootPath]: { ...readiness()[rootPath], destination: 'other' } },
    { [globalsInPlacePath]: { ...readiness()[globalsInPlacePath], state: 'hold' } },
    { [globalsInPlacePath]: { ...readiness()[globalsInPlacePath], destination: 'other' } },
    { [rootPath]: undefined },
  ]) {
    f.moveData({ ...readiness(), ...update });
    expect((await send()).status).toBe(409);
    expect(await (await f.request(me, 'GET', undefined, 4)).json()).not.toHaveProperty(
      'translationPublish',
    );
  }
  expect(f.current()[requestPath(A)]).toBeUndefined();
});

it.each([3, 5, 8, 99])(
  'refuses roles or assignments that do not cover the selected language (%s)',
  async (id) => {
    expect((await send(value, id)).status).toBe(403);
    expect(f.current()[requestPath(A)]).toBeUndefined();
  },
);

it('lets managers publish their assigned language, and operators publish any non-English lane', async () => {
  expect((await send(value, 7)).status).toBe(202);
  const fr = {
    ...replaceRow({ lang: 'fr', expected: await translationExpectedDigest(undefined) }),
    opId: B,
  };
  expect((await send(fr, 4)).status).toBe(403);
  expect((await send(fr, 2)).status).toBe(202);
});

it('rejects English, reserved hashes, path tricks, mixed scope, and unknown or duplicate lanes', async () => {
  for (const raw of [
    replaceRow({ lang: 'en' }),
    replaceRow({ hash: 2 }),
    replaceRow({ hash: '123/../1' }),
    replaceRow({ id: 'g_not_a_tooltip' }),
    replaceRow({ english: { text: 'Forged English' } }),
    replaceRow({ fields: { en: 'English' } }),
    { ...value, rows: [...value.rows, ...value.rows] },
    { ...value, hashes: [1], expected: { 1: 'c'.repeat(64) } },
    { ...value, opId: '../config/permissions' },
    { ...value, scope: undefined },
    {
      ...value,
      rows: [{ ...value.rows[0], kind: 'global', hash: undefined, id: 'g_abc/../permissions' }],
    },
  ]) {
    expect((await send(raw, 2)).status).toBe(400);
  }
  expect((await send({ ...value, extra: 'a'.repeat(307201) })).status).toBe(413);
  const ordinary = {
    opId: A,
    hashes: [123],
    expected: { 123: await publishableHash(saved, f.aliases) },
  };
  const ordinaryRoute = `/publish?contract=${globalsInPlacePublishContract}`;
  expect(
    (await f.request(ordinaryRoute, 'POST', { ...ordinary, rows: value.rows }, 2)).status,
  ).toBe(400);
  expect((await f.request(ordinaryRoute, 'POST', ordinary, 4)).status).toBe(403);
  expect(f.current()[requestPath(A)]).toBeUndefined();
});

it.each(['expected', 'english', 'before'])('rejects a forged %s digest', async (key) => {
  const result = await send(replaceRow({ [key]: '0'.repeat(64) }));
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({
    details: { rows: [{ kind: 'tooltip', hash: 123, lang: 'de', reason: 'review-changed' }] },
  });
  expect(f.current()[requestPath(A)]).toBeUndefined();
});

it('refuses advanced English, stale snapshot OIDs, and former roots with retained snapshots', async () => {
  f.moveData({
    'tooltips/123.json': { ...saved, text: { ...saved.text, en: tooltip('new English').text.en } },
  });
  const changed = await send();
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({
    details: { rows: [{ reason: 'english-pending' }] },
  });
  f.moveData({ 'tooltips/123.json': saved, 'live/tooltips/123.json': tooltip('new English') });
  expect((await send()).status).toBe(409);
  f.moveData({
    'live/tooltips/123.json': live,
    'tooltips/789.json': stored(789),
    'live/tooltips/789.json': { ...live, hash: 789 },
    'live/pushed.json': { 789: await publishableHash({ ...live, hash: 789 }) },
  });
  expect((await send(replaceRow({ hash: 789 }))).status).toBe(409);
  expect(f.current()[requestPath(A)]).toBeUndefined();
});

it('keeps the gate open for a flagged wording change saved through the Worker', async () => {
  const next = {
    ...saved,
    text: { ...saved.text, en: { ...saved.text.en!, text: 'original, corrected' } },
  };
  const body = { changes: [{ hash: 123, base: saved, next }], message: 'Correct English' };
  expect((await f.request('/save', 'POST', body, 2)).status).toBe(422);
  expect(f.current()['tooltips/123.json']).toEqual(saved);
  expect((await f.request('/save', 'POST', { ...body, noTranslationImpact: true }, 2)).status).toBe(
    200,
  );
  expect(f.current()['tooltips/123.json']).toEqual(next);
  expect((await send()).status).toBe(202);
  expect(JSON.parse(envelope().payload).rows).toEqual(value.rows);
});

it('refuses a selected tooltip with an unresolved activation conflict', async () => {
  f.moveData({ [`${schedulePaths.conflictsDir}/123.json`]: {} });
  expect((await send()).status).toBe(409);
  expect(f.current()[requestPath(A)]).toBeUndefined();
});

it('checks saved and published definitions by stable ID, and admits a reviewed withdrawal', async () => {
  const id = 'g_id_fixture';
  const global: GlobalRecord = {
    version: 1,
    id,
    kind: 'variables',
    name: 'Number',
    revision: 'revision1',
    definitions: {
      en: {
        body: '1',
        revision: 'english1',
        updatedAt: '2026-10-01T00:00:00Z',
        updatedBy: 'alice',
      },
      de: {
        body: 'eins',
        revision: 'german1',
        updatedAt: '2026-10-02T00:00:00Z',
        updatedBy: 'dan',
      },
    },
    nameHistory: [],
  };
  const savedEntry = {
    ...global,
    name: 'PendingRename',
    definitions: { en: global.definitions.en },
  };
  const currentPath = globalsReleasePaths.entry(id);
  const publishedPath = globalsReleasePaths.published(f.env.LIVE_BRANCH);
  f.moveData({
    [currentPath]: { ...savedEntry, id: 'g_different' },
    [publishedPath]: {
      version: 1,
      destination: f.env.LIVE_BRANCH,
      store: { version: 1, entries: [global], aggregates: [] },
    },
  });
  const row: TranslationPublishRow = {
    kind: 'global',
    id,
    lang: 'de',
    expected: await translationExpectedDigest(undefined),
    english: await translationEnglishDigest(global.definitions.en!),
    before: await translationBeforeDigest(global.definitions.de),
    effects: 'e'.repeat(64),
    affected: 'f'.repeat(64),
  };
  const body = { ...value, rows: [row] };
  expect((await send(body)).status).toBe(409);
  f.moveData({ [currentPath]: savedEntry });
  expect((await send(body)).status).toBe(202);
  expect(JSON.parse(envelope().payload).rows).toEqual([row]);
});

it('rechecks revoked languages after a CAS race and on retries for an accepted request', async () => {
  const revoked = {
    ...permissionFixture,
    users: { ...permissionFixture.users, '4': { ...config.users['4'], languages: ['fr'] } },
  };
  f.beforePatch = () => f.moveData({ 'config/permissions.json': revoked });
  expect((await send()).status).toBe(403);
  expect(f.current()[requestPath(A)]).toBeUndefined();
  f.beforePatch = undefined;
  f.moveData({ 'config/permissions.json': permissionFixture });
  expect((await send()).status).toBe(202);
  f.moveData({ 'config/permissions.json': revoked });
  expect((await send()).status).toBe(403);
  expect((await kick()).status).toBe(403);
  expect(await (await status()).json()).toEqual({ operations: [{ opId: A, status: 'pending' }] });
});

it('revalidates the reviewed English before a retried write', async () => {
  f.beforePatch = () =>
    f.moveData({
      'tooltips/123.json': {
        ...saved,
        text: { ...saved.text, en: tooltip('English changed during admission').text.en },
      },
    });
  expect((await send()).status).toBe(503);
  const response = await send();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    details: { rows: [{ reason: 'english-pending' }] },
  });
  expect(f.current()[requestPath(A)]).toBeUndefined();
});

it('reconciles a lost write response and only reveals scoped status and kick to the owner or operators', async () => {
  const upstream = f.fetch.bind(f);
  let timedOut = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream(input, init);
    if (!timedOut && String(input).includes('/git/refs/heads/')) {
      timedOut = true;
      throw new Error('Response lost');
    }
    return response;
  });
  expect((await send()).status).toBe(202);
  expect(timedOut).toBe(true);
  const head = f.dataHead;
  expect((await send()).status).toBe(202);
  expect(f.dataHead).toBe(head);
  expect((await send(value, 6)).status).toBe(409);
  expect(await (await status(6)).json()).toEqual({ operations: [{ opId: A, status: 'unknown' }] });
  expect((await kick(6)).status).toBe(403);
  expect((await kick()).status).toBe(202);
  expect((await kick(2)).status).toBe(202);

  const signed = envelope();
  const intentDigest = JSON.parse(signed.payload).intentDigest;
  f.moveData({
    [requestPath(A)]: { unrelated: 'stray request after RECORD' },
    [logPath(A)]: {
      request: signed,
      intentDigest,
      result: {
        status: 'stale',
        error: 'private stack trace',
        rows: [
          { kind: 'tooltip', hash: 123, lang: 'de', reason: 'review-changed', error: 'private' },
          { kind: 'tooltip', hash: 444, lang: 'fr', reason: 'english-pending' },
        ],
      },
    },
  });
  const result = {
    status: 'stale',
    rows: [{ kind: 'tooltip', hash: 123, lang: 'de', reason: 'review-changed' }],
  };
  expect(await (await status()).json()).toEqual({ operations: [{ opId: A, ...result }] });
  expect(await (await status(2)).json()).toEqual({ operations: [{ opId: A, ...result }] });
  expect(await (await status(6)).json()).toEqual({ operations: [{ opId: A, status: 'unknown' }] });
  expect(await (await send()).json()).toEqual({ opId: A, result });
  expect((await kick()).status).toBe(409);
  expect((await kick(6)).status).toBe(403);
});

it('keeps both translators’ independent requests across a head race', async () => {
  const french = stored();
  french.text.fr = { ...french.text.de!, text: 'Version française' };
  f.moveData({ 'tooltips/123.json': french });
  const row = {
    ...value.rows[0]!,
    lang: 'fr',
    expected: await translationExpectedDigest(french.text.fr),
  };
  const upstream = f.fetch.bind(f);
  let competing: Response | undefined;
  let inject = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (inject && String(input).includes('/git/refs/heads/')) {
      inject = false;
      competing = await send({ ...value, opId: B, rows: [row] }, 5);
    }
    return upstream(input, init);
  });
  expect((await send()).status).toBe(503);
  expect(f.current()[requestPath(A)]).toBeUndefined();
  expect((await send()).status).toBe(202);
  expect(competing?.status).toBe(202);
  expect(JSON.parse(envelope(A).payload).rows[0].lang).toBe('de');
  expect(JSON.parse(envelope(B).payload).rows[0].lang).toBe('fr');
  expect(await (await status(5)).json()).toEqual({ operations: [{ opId: A, status: 'unknown' }] });
});

it('admits an entire maximum client part in one read and never silently truncates it', async () => {
  const rows = [];
  const paths: Record<string, unknown> = {};
  const roots: Record<string, string> = {};
  for (let i = 0; i < translationPartRows + 1; i++) {
    const hash = 1000 + i;
    const published = { ...live, hash };
    const current = stored(hash);
    paths[`tooltips/${hash}.json`] = current;
    paths[`live/tooltips/${hash}.json`] = published;
    roots[hash] = blobOid(published);
    rows.push(await tuple(current, published));
  }
  f.moveData({ ...paths, [rootPath]: { ...readiness()[rootPath], roots } });
  expect((await send({ ...value, rows })).status).toBe(413);
  expect(f.current()[requestPath(A)]).toBeUndefined();
  const part = rows.slice(0, translationPartRows);
  expect((await send({ ...value, rows: part })).status).toBe(202);
  expect(f.graphqlCalls).toBe(1);
  expect(f.subrequests).toBeLessThan(10);
  expect(JSON.parse(envelope().payload).rows).toEqual(part);
  const head = f.dataHead;
  expect((await send({ ...value, rows: [...part].reverse() })).status).toBe(202);
  expect(f.dataHead).toBe(head);
});
