import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyGitTree,
  globalsConfigWithoutMarks,
  observeGlobalSources,
  type GlobalSources,
} from '@clarity/core';
import type { GlobalRecord } from '../../../packages/core/src/globals/model.js';
import { GitHub } from '../src/github.js';
import { namePaths } from '../src/globals/index.js';
import {
  globalPublicationRead,
  globalsSwitch,
  maxPublicationConsumers,
  observeGlobals,
} from '../src/globalsRoute.js';
import { blobOid, Fixture, makePrivateKey, sha, tooltip } from './fixture.js';

const id = 'g_abcdefgh';
const entryPath = `/globals/${id}`;
const live = 'converter-v2-test';
const generatorSha = 'd'.repeat(40);
const pinSource = 'e'.repeat(40);
const entry: GlobalRecord = {
  version: 1,
  id,
  kind: 'variables',
  name: 'Damage',
  revision: 'r1',
  nameHistory: [],
  definitions: {
    en: { body: 'old', revision: 'r1', updatedAt: '2026-11-15T00:00:00Z', updatedBy: 'alice' },
  },
};
const current = {
  version: 1,
  status: 'current',
  causeIds: [],
  causeEntries: {},
  lastFailure: null,
};
const fixed = { kind: 'retry', message: 'Sync pending: global storage is unavailable' };
let appKey: string;
let f: Fixture;

beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(() => {
  f = new Fixture(appKey);
  vi.spyOn(globalsSwitch, 'enabled').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bootstrap() {
  f.moveData({
    '.publisher/PIN': {
      sourceSha: pinSource,
      sha256: 'f'.repeat(64),
      capabilities: ['globalsRelease', 'globalsExportsV1'],
    },
    '.publisher/config.json': { generatorSha, facts: {} },
    '.publisher/installed.json': {
      version: 1,
      configOid: blobOid({ generatorSha, facts: {} }),
      generatorSha,
    },
    'globals/layout.json': { version: 1, aggregates: [] },
    [`globals/live/${live}.json`]: { version: 1, destination: live, store: {} },
    'globals/sync.json': current,
    [`globals/entries/${id}.json`]: entry,
    'globals/catalog.json': { version: 1, lastPage: 0 },
    'globals/pages/p0.json': { version: 1, ids: [id], nextCursor: null },
  });
}
/** Writes the current occupied-name proof and claim for the entry, at the CURRENT sources. */
async function admitName(sources: GlobalSources) {
  const locations = await namePaths('variables', 'Damage');
  f.moveData({
    [locations.proof]: {
      version: 1,
      complete: true,
      sources,
      kind: 'variables',
      name: 'Damage',
      occupiedBy: id,
      localClash: false,
      coverage: 'authored-live-upcoming-fallback',
    },
    [locations.claim]: { id, kind: 'variables', name: 'Damage' },
  });
}
type Body = {
  kind?: string;
  message?: string;
  error?: string;
  value?: { entry?: unknown; [key: string]: unknown };
};
const read = async (path: string, user = 1, method = 'GET', value?: unknown) => {
  const response = await f.request(path, method, value, user);
  return { status: response.status, body: (await response.json()) as Body };
};

describe('global entry routes (S5 integration)', () => {
  it('excludes only root marks and verifies the complete config tree against the raw Git OID', async () => {
    bootstrap();
    f.moveData({
      '.publisher/PIN': {
        sourceSha: pinSource,
        capabilities: ['globalsRelease', 'globalsExportsV1', globalsConfigWithoutMarks],
      },
    });
    const github = new GitHub(f.env);
    const before = await observeGlobals(github);
    f.moveData({ 'config/marks.json': { changed: true } });
    expect((await observeGlobals(github)).sources).toEqual(before.sources);

    f.moveData({ 'config/other/marks.json': { nested: true } });
    const nested = await observeGlobals(github);
    expect(nested.sources.config).not.toBe(before.sources.config);
    f.moveData({ 'config/inactive.json': {} });
    expect((await observeGlobals(github)).sources.config).not.toBe(nested.sources.config);

    f.configEntriesOverride = [];
    await expect(observeGlobals(github)).rejects.toMatchObject({
      status: 503,
      message: fixed.message,
    });
  });
  it('stays off before authentication by default', async () => {
    vi.mocked(globalsSwitch.enabled).mockReturnValue(false);
    const result = await read(entryPath);
    expect(result).toEqual({ status: 503, body: { error: 'Global entries are not enabled' } });
    expect(f.graphqlCalls).toBe(0);
  });

  it('authorizes before revealing bootstrap state, and fails closed when partial', async () => {
    expect((await read(entryPath, 99)).body.kind).toBe('forbidden');
    expect(await read(entryPath)).toEqual({
      status: 503,
      body: { kind: 'retry', message: 'Sync pending: global metadata is incomplete' },
    });
    bootstrap();
    f.moveData({ [`globals/live/${live}.json`]: undefined });
    expect((await read(entryPath)).body.message).toBe(
      'Sync pending: global metadata is incomplete',
    );
  });

  it('observes every contract identity from one head', async () => {
    bootstrap();
    const files = f.current();
    const observed = await observeGlobals(new GitHub(f.env));
    expect(observed.head).toBe(f.dataHead);
    expect(observed.sources).toEqual(
      await observeGlobalSources({
        authored: f.treeOid(files, 'tooltips')!,
        definitions: f.treeOid(files, 'globals/entries')!,
        projections: emptyGitTree,
        layout: (await observedBlob('globals/layout.json'))!,
        published: (await observedBlob(`globals/live/${live}.json`))!,
        config: f.treeOid(files, 'config')!,
        live: f.liveHead,
        upcoming: emptyGitTree,
        aliasGroups: null,
        sandboxPointers: null,
        generator: generatorSha,
        resolverRevision: pinSource,
      }),
    );
  });

  it('serves bounded reads and commits a body edit with the observed sources', async () => {
    bootstrap();
    await admitName((await observeGlobals(new GitHub(f.env))).sources);
    // The catalogue ships in the editor-data bundle: no paged Worker read, and no GitHub call.
    const calls = f.graphqlCalls;
    expect(await read('/globals')).toEqual({
      status: 405,
      body: { kind: 'invalid', message: 'Method not allowed' },
    });
    expect((await read('/globals?cursor=p0')).status).toBe(405);
    expect(f.graphqlCalls).toBe(calls);
    const opened = await read(entryPath);
    expect(opened.status).toBe(200);
    expect(opened.body.value).toMatchObject({ head: f.dataHead, entry, status: 'current' });
    const before = (await observeGlobals(new GitHub(f.env))).sources;
    const saved = await read(`/globals/${id}/body`, 2, 'POST', {
      expectedHead: f.dataHead,
      mutation: { operation: 'edit', id, revision: 'r1', lang: 'en', body: 'new' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.value).toMatchObject({ status: 'sync-pending', head: f.dataHead });
    const cause = Object.entries(f.current()).find(([path]) => path.startsWith('globals/causes/'));
    expect(cause?.[1]).toMatchObject({ operation: 'edit', beforeSources: before });
  });

  it('reads the real-head shape with a 2.37 MB installed config beyond GraphQL text', async () => {
    bootstrap();
    const installed = { generatorSha, facts: { padding: 'x'.repeat(2_371_000) } };
    const snapshots = Object.fromEntries(
      Array.from({ length: 2614 }, (_, n) => [`live/tooltips/${n}.json`, { hash: n }]),
    );
    f.moveData({
      '.publisher/config.json': installed,
      '.publisher/installed.json': { version: 1, configOid: blobOid(installed), generatorSha },
      ...snapshots,
    });
    f.rawOverrides.set('.publisher/config.json', { isTruncated: true, text: null });
    const upstream = globalThis.fetch;
    const rawReads: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/git/blobs/')) {
        expect(new Headers(init?.headers).get('Accept')).toBe('application/vnd.github.raw+json');
        rawReads.push(String(input));
      }
      return upstream(input, init);
    });
    for (const path of [entryPath, entryPath, entryPath]) {
      const start = f.subrequests;
      expect((await read(path)).status).toBe(200);
      expect(f.subrequests - start).toBeLessThan(10);
    }
    expect(rawReads).toHaveLength(0);
    // Changing config alone refuses, even after a successful read of the old binding.
    const next = { ...installed, generatorSha: 'c'.repeat(40) };
    f.moveData({ '.publisher/config.json': next });
    expect((await read(entryPath)).status).toBe(503);
    f.moveData({
      '.publisher/installed.json': {
        version: 1,
        configOid: blobOid(next),
        generatorSha: next.generatorSha,
      },
    });
    expect((await observeGlobals(new GitHub(f.env))).sources.generator).toBe('c'.repeat(40));
    expect(rawReads).toHaveLength(0);
    expect(f.writes).toEqual([]);
  });

  it.each([
    undefined,
    null,
    'x'.repeat(1024),
    {},
    { version: 2, configOid: 'a'.repeat(40), generatorSha },
    { version: 1, configOid: 'a'.repeat(40), generatorSha },
    { version: 1, configOid: blobOid({ generatorSha, facts: {} }), generatorSha: 'invalid' },
    { version: 1, configOid: blobOid({ generatorSha, facts: {} }), generatorSha, extra: true },
  ])('refuses missing, malformed, or mismatched installed metadata: %j', async (metadata) => {
    bootstrap();
    f.moveData({ '.publisher/installed.json': metadata });
    expect(await read(entryPath)).toEqual({
      status: 503,
      body: { kind: 'retry', message: 'Sync pending: global metadata is incomplete' },
    });
    expect(f.writes).toEqual([]);
  });

  it.each([
    { oid: 'f'.repeat(40) },
    { isTruncated: true, text: null },
    { byteSize: 1 },
    { isBinary: true },
  ])('refuses corrupted installed-metadata transport: %j', async (override) => {
    bootstrap();
    f.rawOverrides.set('.publisher/installed.json', override);
    expect(await read(entryPath)).toEqual({ status: 503, body: fixed });
    expect(f.writes).toEqual([]);
  });

  it('refuses a proof made stale by a generic tooltip save', async () => {
    bootstrap();
    await admitName((await observeGlobals(new GitHub(f.env))).sources);
    f.moveData({ 'tooltips/123.json': tooltip('consumer changed') });
    const saved = await read(`/globals/${id}/body`, 2, 'POST', {
      expectedHead: f.dataHead,
      mutation: { operation: 'edit', id, revision: 'r1', lang: 'en', body: 'new' },
    });
    expect(saved).toEqual({
      status: 503,
      body: { kind: 'retry', message: 'Sync pending: source proof is stale; retry after sync' },
    });
  });

  it.each([
    ['binary', { isBinary: true }],
    ['unknown binary state', { isBinary: null }],
    ['truncated', { isTruncated: true, text: null }],
    ['size mismatch', { byteSize: 3 }],
    ['same-length different bytes', { oid: 'f'.repeat(40) }],
    ['oversized', { byteSize: 70_000, text: 'x'.repeat(70_000) }],
    ['response over the stream cap', { byteSize: 1, text: 'x'.repeat(400_000) }],
  ])('refuses a %s Blob with one fixed message (R3/R4/R8)', async (_name, override) => {
    bootstrap();
    f.rawOverrides.set(`globals/entries/${id}.json`, override);
    expect(await read(`/globals/${id}`)).toEqual({ status: 503, body: fixed });
  });

  it('refuses a binary PIN and a non-blob metadata path', async () => {
    bootstrap();
    f.rawOverrides.set('.publisher/PIN', { isBinary: true });
    expect(await read(entryPath)).toEqual({ status: 503, body: fixed });
    f.rawOverrides.clear();
    f.moveData({
      [`globals/entries/${id}.json`]: undefined,
      [`globals/entries/${id}.json/nested.json`]: entry,
    });
    expect(await read(`/globals/${id}`)).toEqual({ status: 503, body: fixed });
  });

  it('lists entry history and reads a historical record for restore', async () => {
    bootstrap();
    const commit = f.dataHead;
    const list = await read(`/globals/${id}/history`, 4);
    expect(list.body.value).toMatchObject({ head: commit, page: 1, commits: [{ commit: sha(1) }] });
    const record = await read(`/globals/${id}/history?commit=${commit}`, 3);
    expect(record.body).toEqual({ kind: 'ok', value: { head: commit, commit, entry } });
    expect((await read(`/globals/${id}/history?commit=${sha(77)}`)).status).toBe(404);
    expect((await read(`/globals/${id}/history?other=1`)).body.kind).toBe('invalid');
    expect((await read(`/globals/${id}/history`, 99)).body.kind).toBe('forbidden');
  });

  it.each([1, 2, 3])(
    'refuses deleting compatibility library %i, but not removing a batch member',
    async (hash) => {
      const user = { id: 1, login: 'alice' };
      const path = `tooltips/${hash}.json`;
      const batchMember = `schedule/batches/B/${path}`;
      bootstrap();
      f.moveData({ [path]: { ...tooltip(), hash }, [batchMember]: {} });
      const github = new GitHub(f.env);
      await expect(
        github.commit(f.dataHead, {}, 'Delete', user, { deletions: [path] }),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.current()[path]).toBeDefined();
      await github.commit(f.dataHead, {}, 'Remove member', user, { deletions: [batchMember] });
      expect(f.current()[batchMember]).toBeUndefined();
    },
  );

  it.each([1, 2, 3])(
    'refuses raw aggregate %i saves once globals exist, but keeps legacy saves',
    async (hash) => {
      const path = `tooltips/${hash}.json`;
      const aggregate = { ...tooltip(), hash };
      f.moveData({ [path]: aggregate });
      const change = { hash, base: aggregate, next: { ...tooltip('legacy edit'), hash } };
      const legacy = await read('/save', 1, 'POST', { changes: [change], message: 'Legacy' });
      expect(legacy.status).toBe(200);
      bootstrap();
      const next = f.current()[path];
      const refused = await read('/save', 1, 'POST', {
        changes: [
          { hash, base: next, next: { ...tooltip('raw edit', '2026-10-02T00:00:00Z'), hash } },
        ],
        message: 'Raw',
      });
      expect(refused).toEqual({
        status: 409,
        body: { error: 'Use global entry mutations; Sync pending protection is required' },
      });
      expect(f.current()[path]).toEqual(next);
    },
  );

  it('reads one publication certificate per consumer, in order, at the same head', async () => {
    bootstrap();
    const certificate = { version: 1, marker: 'de' };
    f.moveData({ [`globals/proofs/publication/${live}/123-de.json`]: certificate });
    const reader = globalPublicationRead(new GitHub(f.env));
    const consumers = [
      { hash: 123, lang: 'de', destination: live },
      { hash: 123, lang: 'en', destination: live },
    ];
    const proof = await reader(f.dataHead, consumers);
    expect(proof).toEqual({
      sources: (await observeGlobals(new GitHub(f.env))).sources,
      sync: current,
      materializedSources: null,
      certificates: [certificate, null],
    });
    await expect(reader(sha(5), consumers)).rejects.toMatchObject({ status: 409 });
    await expect(
      reader(f.dataHead, [{ hash: 123, lang: 'de', destination: 'elsewhere' }]),
    ).rejects.toMatchObject({ status: 409 });
    const many = Array.from({ length: maxPublicationConsumers + 1 }, (_, hash) => ({
      hash,
      lang: 'en',
      destination: live,
    }));
    await expect(reader(f.dataHead, many)).rejects.toMatchObject({ status: 422 });
  });
});

async function observedBlob(path: string): Promise<string | null> {
  const { createHash } = await import('node:crypto');
  const value = f.current()[path];
  if (value === undefined) return null;
  const text = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${text.length}\0`), text]))
    .digest('hex');
}
