import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { publishMonth, type PublishPayload } from '@clarity/core';
import { Fixture, makePrivateKey, config } from './fixture.js';
import worker from '../src/index.js';
import { Publisher } from '../../../scripts/publisher/publisher.js';
import type { Repository } from '../../../scripts/publisher/git.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: true } }));

const A = '01K95H00000000000000000001';
const requestPath = `publish/requests/${A}.json`;
const logPath = `publish/log/${publishMonth(A)}/${A}.json`;
const time = [...A.slice(0, 10)].reduce(
  (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
  0,
);
const value = { opId: A, hashes: [123], expected: { 123: 'a'.repeat(64) } };
let appKey: string;
let f: Fixture;
beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: time });
  f = new Fixture(appKey);
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const envelope = () => f.current()[requestPath] as { payload: string; sig: string };
const payload = () => JSON.parse(envelope().payload) as PublishPayload;

it('signs full canonical bytes; public endpoint round-trips with the actual publisher verifier', async () => {
  const response = await f.request('/publish', 'POST', value, 2);
  expect(response.status).toBe(202);
  expect(f.subrequests).toBe(5);
  const count = f.subrequests;
  const keyResponse = await worker.fetch(new Request('https://api.example/publish/key'), f.env, {
    waitUntil() {},
  });
  const key = (await keyResponse.json()) as { publicKey: string; fingerprint: string };
  expect(f.subrequests).toBe(count);
  expect(key.fingerprint).toBe(
    createHash('sha256')
      .update(createPublicKey(key.publicKey).export({ type: 'spki', format: 'der' }))
      .digest('hex'),
  );
  expect(JSON.stringify(key)).not.toContain('PRIVATE');
  let signed = JSON.stringify(envelope());
  // verifyRequest only needs a blob reader; no repository transport or writes.
  const unused = (): never => {
    throw new Error('Unexpected verifier repository operation');
  };
  const git: Repository = {
    blob: () => signed,
    head: unused,
    tree: unused,
    writeBlob: unused,
    commit: unused,
    cas: unused,
    ancestor: unused,
    history: unused,
    additions: unused,
  };
  const verifier = new Publisher(git, {
    repo: 'test-org/scratch',
    dataBranch: f.env.DATA_BRANCH,
    liveBranch: f.env.LIVE_BRANCH,
    publicKey: key.publicKey,
    keyFingerprint: key.fingerprint,
    publisherSha: '',
    generatorSha: '',
    aliases: {},
    facts: {},
    now: () => time,
    runUrl: '',
  });
  const permissions = { blob: JSON.stringify(config) };
  git.blob = (oid) => (oid === 'permission' ? permissions.blob : signed);
  const tree = { 'config/permissions.json': 'permission' };
  expect((await verifier.verifyRequest('signed', A, tree)).requester.id).toBe(2);
  const original = envelope();
  for (const change of [
    { liveBranch: 'live' },
    { repo: 'evil/repo' },
    { requester: { id: 1, login: 'alice' } },
    { createdAt: new Date(time + 1).toISOString() },
    { expected: { 123: 'b'.repeat(64) } },
  ]) {
    signed = JSON.stringify({ ...original, payload: JSON.stringify({ ...payload(), ...change }) });
    await expect(verifier.verifyRequest('signed', A, tree)).rejects.toThrow('signature');
  }
  signed = JSON.stringify({ payload: original.payload, sig: Buffer.alloc(64).toString('base64') });
  await expect(verifier.verifyRequest('signed', A, tree)).rejects.toThrow('signature');
  signed = JSON.stringify(original);
  permissions.blob = JSON.stringify({ users: { '2': { login: 'bob', role: 'trial' } } });
  await expect(verifier.verifyRequest('signed', A, tree)).rejects.toThrow('revoked');
});

it.each([3, 4, 99])('rejects non-editor numeric id %s even with an editor login', async (id) => {
  expect((await f.request('/publish', 'POST', value, id)).status).toBe(403);
  expect((await f.request(`/publish/status?opId=${A}`, 'GET', undefined, id)).status).toBe(403);
  expect((await f.request('/publish/kick', 'POST', { opId: A }, id)).status).toBe(403);
  expect(f.commits).toHaveLength(0);
});

it('uses numeric permission keys, never the stored login', async () => {
  f.moveData({
    'config/permissions.json': { users: { '99': { login: 'alice', role: 'editor' } } },
  });
  expect((await f.request('/publish', 'POST', value)).status).toBe(403);
});

it('lost 202 at a different time returns original 202 and immutable request; conflicts are 409', async () => {
  expect((await f.request('/publish', 'POST', value)).status).toBe(202);
  const first = structuredClone(envelope());
  const h = f.dataHead;
  vi.setSystemTime(time + 3 * 86400000);
  expect((await f.request('/publish', 'POST', value)).status).toBe(202);
  expect(f.dataHead).toBe(h);
  expect(envelope()).toEqual(first);
  expect(
    (await f.request('/publish', 'POST', { ...value, expected: { 123: 'b'.repeat(64) } })).status,
  ).toBe(409);
  const result = { status: 'done', outcomes: [{ hash: 123, status: 'published' }] };
  const files = { ...f.current() };
  delete files[requestPath];
  files[logPath] = { intentDigest: payload().intentDigest, result };
  f.moveData(files);
  delete f.current()[requestPath];
  expect(await (await f.request('/publish', 'POST', value)).json()).toEqual({ opId: A, result });
});

it.each([true, false])(
  'create timeout reconciles authoritative head (landed=%s)',
  async (landed) => {
    const fetch = f.fetch.bind(f);
    let injected = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/git/refs/heads/') && !injected) {
          injected = true;
          if (landed) await fetch(input, init);
          else {
            f.subrequests++;
          }
          throw new Error('Timeout');
        }
        return fetch(input, init);
      }),
    );
    expect((await f.request('/publish', 'POST', value)).status).toBe(202);
    expect(f.subrequests).toBe(landed ? 6 : 9);
    expect(Object.keys(f.current()).filter((p) => p.startsWith('publish/requests/'))).toEqual([
      requestPath,
    ]);
  },
);

it('delayed create after RECORD loses its stale parent and returns the recorded result', async () => {
  const fetch = f.fetch.bind(f);
  let once = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/git/refs/heads/') && !once) {
        once = true;
        const created = [...f.snapshots.values()].find((v) => v[requestPath])![requestPath] as {
          payload: string;
        };
        f.moveData({
          [logPath]: {
            intentDigest: JSON.parse(created.payload).intentDigest,
            result: { status: 'done' },
          },
        });
        // Let the fixture enforce the stale-parent rejection, just as GitHub does.
      }
      return fetch(input, init);
    }),
  );
  const response = await f.request('/publish', 'POST', value);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ opId: A, result: { status: 'done' } });
  expect(f.current()[requestPath]).toBeUndefined();
  expect(f.subrequests).toBe(6);
});

it('exhausts races with final reconciliation, at most 10 requests (design cap 13, global cap 48)', async () => {
  const advance = () => {
    f.moveData();
    f.beforePatch = advance;
  };
  f.beforePatch = advance;
  expect((await f.request('/publish', 'POST', value)).status).toBe(503);
  expect(f.subrequests).toBe(10);
  expect(f.subrequests).toBeLessThanOrEqual(13);
  expect(f.current()[requestPath]).toBeUndefined();
});

it('rechecks authorization after a create race', async () => {
  f.beforePatch = () => f.moveData({ 'config/permissions.json': { users: {} } });
  expect((await f.request('/publish', 'POST', value)).status).toBe(403);
  expect(f.current()[requestPath]).toBeUndefined();
});

it('rejects stale creation, extra targets, missing digests and oversize input before writing', async () => {
  vi.setSystemTime(time + 2 * 86400000);
  expect((await f.request('/publish', 'POST', value)).status).toBe(400);
  for (const invalid of [
    { ...value, liveBranch: 'live' },
    { ...value, expected: {} },
    { ...value, opId: '../invalid' },
  ]) {
    expect((await f.request('/publish', 'POST', invalid)).status).toBe(400);
  }
  expect((await f.request('/publish', 'POST', { extra: 'x'.repeat(307201) })).status).toBe(413);
  expect(f.commits).toHaveLength(0);
});

it('fails closed without the enable-time signing key, and bounds truncated metadata without fallbacks', async () => {
  delete f.env.PUBLISH_SIGNING_KEY;
  expect((await f.request('/publish', 'POST', value)).status).toBe(503);
  expect(f.commits).toHaveLength(0);
  f.truncateGraphql = true;
  const before = f.subrequests;
  expect((await f.request('/publish', 'POST', value)).status).toBe(502);
  expect(f.subrequests - before).toBe(2);
});

it('status is fixed, bounded to one id and two subrequests; kick is pending-only and three', async () => {
  await f.request('/publish', 'POST', value);
  let before = f.subrequests;
  expect(await (await f.request(`/publish/status?opId=${A}`)).json()).toEqual({
    operations: [{ opId: A, status: 'pending' }],
  });
  expect(f.subrequests - before).toBe(2);
  expect((await f.request(`/publish/status?${Array(2).fill(`opId=${A}`).join('&')}`)).status).toBe(
    400,
  );
  before = f.subrequests;
  expect((await f.request('/publish/kick', 'POST', { opId: A }, 2)).status).toBe(202);
  expect(f.subrequests - before).toBe(3);
  expect(f.writes[0]).toMatchObject({ branch: f.env.DATA_BRANCH });
  f.moveData({
    [logPath]: {
      intentDigest: payload().intentDigest,
      result: { status: 'rejected', error: 'private details' },
    },
  });
  expect((await f.request('/publish/kick', 'POST', { opId: A })).status).toBe(409);
  expect(await (await f.request(`/publish/status?opId=${A}`)).json()).toEqual({
    operations: [{ opId: A, status: 'rejected' }],
  });
  expect(f.writes).toHaveLength(1);
});
it('final create timeout that landed is reconciled before returning', async () => {
  f.beforePatch = () => f.moveData();
  const fetch = f.fetch.bind(f);
  let patches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).includes('/git/refs/heads/') && ++patches === 2)
        throw new Error('Final write response lost');
      return response;
    }),
  );
  expect((await f.request('/publish', 'POST', value)).status).toBe(202);
  expect(f.subrequests).toBe(10);
  expect(envelope()).toBeDefined();
});
it('status/kick query request IDs only; kick also avoids downloading a large terminal log', async () => {
  f.moveData({ [requestPath]: { payload: 'x'.repeat(300 * 1024), sig: 'test' } });
  const queries: string[] = [];
  const fetch = f.fetch.bind(f);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/graphql')) queries.push(JSON.parse(String(init?.body)).query);
      return fetch(input, init);
    }),
  );
  expect(await (await f.request(`/publish/status?opId=${A}`)).json()).toEqual({
    operations: [{ opId: A, status: 'pending' }],
  });
  expect((await f.request('/publish/kick', 'POST', { opId: A })).status).toBe(202);
  expect(queries[0]).toContain('o1:file(path:$p1){object{... on Blob{oid}}}');
  expect(queries[1]).toContain('o1:file(path:$p1){object{... on Blob{oid}}}');
  expect(queries[1]).toContain('o2:file(path:$p2){object{... on Blob{oid}}}');
  f.moveData({
    [logPath]: {
      request: { payload: 'x'.repeat(300 * 1024) },
      intentDigest: 'a'.repeat(64),
      result: {
        status: 'done',
        outcomes: Array.from({ length: 3000 }, (_, hash) => ({
          hash,
          status: 'published',
          digest: 'a'.repeat(64),
        })),
      },
    },
  });
  expect((await f.request('/publish/kick', 'POST', { opId: A })).status).toBe(409);
  expect(await (await f.request(`/publish/status?opId=${A}`)).json()).toEqual({
    operations: [{ opId: A, status: 'done' }],
  });
  const before = f.subrequests;
  expect((await f.request(`/publish/status?${Array(20).fill(`opId=${A}`).join('&')}`)).status).toBe(
    400,
  );
  expect(f.subrequests).toBe(before);
});
