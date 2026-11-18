import { describe, expect, it, vi } from 'vitest';
import { blobContent, blobSha, RefRace } from '../src/github.js';
import {
  globalsHandler,
  namePaths,
  publicGlobalSync,
  type GlobalsContext,
} from '../src/globals/handlers.js';
import { assertGlobalsPublication, assertNoRawGlobalMutation } from '../src/globals/guards.js';
import { limits, paths, syncSchema, type Mutation, type Sources } from '../src/globals/model.js';
import type { GlobalRecord } from '../../../packages/core/src/globals/model.js';
import { readGlobalFiles, type GlobalsStorage } from '../src/globals/storage.js';
import { globalFileBytes, nameProofRequestSchema } from '../src/globals/model.js';

const head = 'a'.repeat(40),
  digest = 'b'.repeat(64),
  id = 'g_abcdefgh';
const sources: Sources = {
  authored: head,
  definitions: head,
  projections: head,
  config: head,
  live: head,
  upcoming: head,
  aliases: head,
  generator: head,
  fallback: digest,
  resolver: digest,
};
const consumer = { hash: 42, lang: 'de' as const, destination: 'live' };
const entry: GlobalRecord = {
  version: 1,
  id,
  kind: 'variables',
  name: 'Damage',
  revision: 'r1',
  nameHistory: [],
  definitions: {
    en: {
      body: 'old',
      revision: 'r1',
      updatedAt: '2026-11-15T00:00:00Z',
      updatedBy: 'editor',
      provenance: {
        repository: 'owner/data',
        revision: 'r0',
        path: 'tooltips/2.json',
        selector: ['text', 'en', 'text'],
        spanConvention: 'decoded-utf16',
        hash: 2,
        lang: 'en',
        from: 0,
        to: 16,
      },
    },
  },
};
const edit: Mutation = { operation: 'edit', id, revision: 'r1', lang: 'en', body: 'new' };
const ack: Mutation = {
  operation: 'acknowledge',
  id,
  consumerId: 'review1',
  contentDigest: digest,
  dependencyDigest: digest,
  impactDigest: digest,
  decision: 'no-text-change',
};
const current = {
  version: 1,
  status: 'current',
  causeIds: [],
  causeEntries: {},
  lastFailure: null,
};
const proof = { version: 1, complete: true, sources };

async function fixture() {
  const files = new Map<string, unknown>([
    [paths.sync, structuredClone(current)],
    [paths.entry(id), structuredClone(entry)],
    ['globals/catalog.json', { version: 1, lastPage: 0 }],
    [paths.page('p0'), { version: 1, ids: [id], nextCursor: null }],
  ]);
  const ctx: GlobalsContext = {
    head,
    sources: structuredClone(sources),
    access: { login: 'editor', role: 'editor' },
    user: { id: 1, login: 'editor' },
    repository: 'owner/data',
    destinations: ['live', 'upcoming'],
    storage: {
      readFiles: vi.fn<GlobalsStorage['readFiles']>(async (paths: readonly string[]) =>
        Promise.all(
          paths.map(async (path) =>
            files.has(path)
              ? {
                  sha: await blobSha(blobContent(files.get(path))),
                  bytes: new TextEncoder().encode(blobContent(files.get(path))),
                }
              : null,
          ),
        ),
      ),
      commit: vi.fn(async (expected, changes) => {
        expect(expected).toBe(ctx.head);
        for (const [path, value] of Object.entries(changes))
          files.set(path, structuredClone(value));
        return 'c'.repeat(40);
      }),
    },
  };
  const admit = async (name = 'Damage', occupiedBy: string | null = id, kind = 'variables') => {
    const locations = await namePaths(kind, name);
    files.set(locations.proof, {
      ...proof,
      kind,
      name,
      occupiedBy,
      localClash: false,
      coverage: 'authored-live-upcoming-fallback',
    });
    if (occupiedBy) files.set(locations.claim, { kind, name, id: occupiedBy });
    return locations;
  };
  await admit();
  const row = () => {
    const causes = [{ globalId: id, beforeRevision: 'r0', afterRevision: 'r1' }];
    return {
      ...proof,
      id: 'review1',
      projected: false,
      impactDigest: digest,
      review: { version: 1, consumer, causes, contentDigest: digest, dependencyDigest: digest },
      view: {
        consumer,
        causes,
        reason: 'variable-read',
        before: null,
        after: null,
        variant: 42,
        name: 'Consumer',
        category: 'test',
        line: null,
        path: null,
        direct: null,
        archived: true,
        beforeSource: '',
        afterSource: '',
      },
    };
  };
  files.set(paths.row('review1'), row());
  files.set(`globals/review-pages/${id}/p0.json`, { ...proof, ids: ['review1'], nextCursor: null });
  const call = async (
    mutation: Mutation = edit,
    overrides: Record<string, unknown> = {},
    route?: string,
  ) => {
    const endpoint =
      route ??
      (mutation.operation === 'create'
        ? '/globals'
        : `/globals/${mutation.id}/${mutation.operation === 'edit' ? 'body' : mutation.operation}`);
    const response = await globalsHandler(
      new Request(`https://local${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ expectedHead: ctx.head, mutation, ...overrides }),
      }),
      async () => ctx,
    );
    return { status: response.status, data: await response.json() };
  };
  return { ctx, files, admit, call, row };
}

describe('bounded global admission and durable Sync pending', () => {
  it('admits export edits through the same roles, proofs, causes, and atomic commit as variables', async () => {
    const f = await fixture();
    const exported: GlobalRecord = {
      ...structuredClone(entry),
      kind: 'exports',
      name: 'anti_barrier',
    };
    exported.definitions.en!.provenance!.hash = 1;
    exported.definitions.en!.provenance!.path = 'tooltips/1.json';
    f.files.set(paths.entry(id), exported);
    await f.admit(exported.name, id, 'exports');
    const result = await f.call({ ...edit, body: 'Disrupts Barrier Champions.' });
    expect(result.status).toBe(200);
    expect(f.ctx.storage.commit).toHaveBeenCalledTimes(1);
    expect(f.files.get(paths.entry(id))).toMatchObject({
      kind: 'exports',
      definitions: { en: { body: 'Disrupts Barrier Champions.' } },
    });
    expect(f.files.get(`globals/causes/${result.data.value.causeIds[0]}.json`)).toMatchObject({
      globalId: id,
      operation: 'edit',
    });
    const denied = await fixture();
    denied.files.set(paths.entry(id), exported);
    denied.ctx.access = { role: 'translator', login: 'translator', languages: ['de'] };
    expect((await denied.call(edit)).status).toBe(403);
    expect((await denied.call({ operation: 'remove', id, revision: 'r1' })).status).toBe(403);
    expect(() => assertNoRawGlobalMutation([1])).toThrow('Use global entry mutations');
  });
  it('pins the observed blob ID instead of guessing the original file serialization', async () => {
    const f = await fixture(),
      actualRead = vi.mocked(f.ctx.storage.readFiles).getMockImplementation()!;
    vi.mocked(f.ctx.storage.readFiles).mockImplementation(async (...args) =>
      (await actualRead(...args)).map((file, i) =>
        file && args[0][i] === paths.entry(id) ? { ...file, sha: 'f'.repeat(40) } : file,
      ),
    );
    const result = await f.call();
    expect(f.files.get(`globals/causes/${result.data.value.causeIds[0]}.json`)).toMatchObject({
      before: { blob: 'f'.repeat(40) },
    });
  });

  it('rolls the catalog tail forward in the same bounded create commit', async () => {
    const f = await fixture();
    await f.admit('Fresh', null);
    f.files.set(paths.page('p0'), {
      version: 1,
      ids: [id, 'g_second12', 'g_third123'],
      nextCursor: null,
    });
    const result = await f.call({
      operation: 'create',
      kind: 'variables',
      name: 'Fresh',
      lang: 'en',
      body: 'x',
    });
    expect(result.status).toBe(200);
    expect(f.files.get(paths.page('p0'))).toMatchObject({ nextCursor: 'p1' });
    expect(f.files.get(paths.page('p1'))).toEqual({
      version: 1,
      ids: [result.data.value.entry.id],
      nextCursor: null,
    });
    expect(f.files.get('globals/catalog.json')).toEqual({ version: 1, lastPage: 1 });
    expect(f.ctx.storage.commit).toHaveBeenCalledTimes(1);
  });

  it('bounds UTF-8 entry bytes independently of request characters and refuses whole-entry removal without its own verdict', async () => {
    const f = await fixture();
    // Fits the HTTP byte cap but the persisted provenance and definition push it over the entry cap.
    f.files.set(paths.entry(id), {
      ...entry,
      definitions: {
        ...entry.definitions,
        de: {
          ...entry.definitions.en,
          body: 'z'.repeat(7000),
          provenance: { ...entry.definitions.en!.provenance, lang: 'de' },
        },
      },
    });
    const oversized = await f.call({ ...edit, body: '字'.repeat(3000) });
    expect(oversized.status).toBe(413);
    expect(oversized.data.kind).toBe('invalid');
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
    f.files.set(paths.entry(id), entry);
    f.ctx.access.role = 'maintainer';
    expect((await f.call({ operation: 'remove', id, revision: 'r1' })).status).toBe(503);
    f.files.set(paths.removal(id), {
      ...proof,
      id,
      revision: 'r1',
      lang: null,
      references: {
        authored: 0,
        effective: 0,
        live: 0,
        upcoming: 0,
        unresolved: 0,
        conservativeTitles: 0,
      },
    });
    const removed = await f.call({ operation: 'remove', id, revision: 'r1' });
    expect(removed.status).toBe(200);
    expect(removed.data.value.entry.tombstone.by).toBe('editor');
    expect(removed.data.value.entry.id).toBe(id);
  });
  it('commits definition, projection metadata, exact blob identities, and pending cause in one CAS', async () => {
    const f = await fixture(),
      oldBlob = await blobSha(blobContent(entry));
    const result = await f.call();
    expect(result.status).toBe(200);
    expect(result.data.kind).toBe('ok');
    expect(result.data.value).toMatchObject({
      status: 'sync-pending',
      message: 'Sync pending',
      lastFailure: null,
    });
    expect(JSON.stringify(result.data)).not.toMatch(/affected|impact.pending/i);
    expect(f.ctx.storage.commit).toHaveBeenCalledTimes(1);
    const causeId = result.data.value.causeIds[0];
    const cause = f.files.get(`globals/causes/${causeId}.json`);
    expect(cause).toMatchObject({
      beforeSources: sources,
      expectedHead: head,
      before: { blob: oldBlob, revision: 'r1' },
      after: { blob: await blobSha(blobContent(result.data.value.entry)) },
    });
    expect(f.files.get(`globals/projections/${id}.json`)).toMatchObject({
      status: 'sync-pending',
      operation: 'edit',
    });
    expect(result.data.value.entry.definitions.en.provenance).toEqual(
      entry.definitions.en!.provenance,
    );
  });

  it('preserves every earlier cause and failure across consecutive saves', async () => {
    const f = await fixture();
    f.files.set(paths.sync, {
      version: 1,
      status: 'sync-failed',
      causeIds: ['previous'],
      causeEntries: { previous: id },
      lastFailure: 'Offline validation failed',
    });
    f.files.set('globals/causes/previous.json', { unchanged: true });
    const first = await f.call();
    f.ctx.head = first.data.value.head;
    const second = await f.call({
      ...edit,
      revision: first.data.value.entry.revision,
      body: 'again',
    });
    expect(second.data.value.causeIds).toEqual([
      'previous',
      ...first.data.value.causeIds.slice(1),
      expect.any(String),
    ]);
    expect(second.data.value.lastFailure).toBe('Sync failed. Retry sync.');
    expect(f.files.get('globals/causes/previous.json')).toEqual({ unchanged: true });
  });

  it('queues rename without changing the definition, ID, history, or completion state', async () => {
    const f = await fixture();
    await f.admit('NewName', null);
    const result = await f.call({ operation: 'rename', id, revision: 'r1', name: 'NewName' });
    expect(result.status).toBe(200);
    expect(result.data.value).toMatchObject({
      entry,
      renameCompleted: false,
      status: 'sync-pending',
    });
    expect(f.files.get(paths.entry(id))).toEqual(entry);
    expect(f.files.get(`globals/intents/${result.data.value.intentId}.json`)).toMatchObject({
      globalId: id,
      expectedHead: head,
      sources,
      name: 'NewName',
      revision: 'r1',
    });
    expect(
      (
        await f.call({
          operation: 'create',
          kind: 'variables',
          name: 'NewName',
          lang: 'en',
          body: 'value',
        })
      ).status,
    ).toBe(409);
  });

  it('creates a stable ID, claim, and bounded catalog entry without inventing migration ancestry', async () => {
    const f = await fixture();
    await f.admit('Fresh', null);
    const result = await f.call({
      operation: 'create',
      kind: 'variables',
      name: 'Fresh',
      lang: 'en',
      body: '',
    });
    expect(result.status).toBe(200);
    const saved = result.data.value.entry;
    expect(saved.id).toMatch(/^g_/);
    expect(saved.definitions.en.body).toBe('');
    expect(saved.definitions.en.provenance).toBeUndefined();
    expect(
      Object.keys(vi.mocked(f.ctx.storage.commit).mock.calls[0][1]).some((path) =>
        path.startsWith('globals/sources/'),
      ),
    ).toBe(false);
    expect(f.files.get(paths.page('p0'))).toMatchObject({ ids: [id, saved.id] });
  });

  it.each([
    'authored',
    'definitions',
    'projections',
    'config',
    'live',
    'upcoming',
    'aliases',
    'generator',
    'fallback',
    'resolver',
  ] as const)('refuses stale %s identity without scanning or committing', async (key) => {
    const f = await fixture();
    f.ctx.sources[key] = 'd'.repeat(key === 'fallback' || key === 'resolver' ? 64 : 40);
    expect((await f.call()).status).toBe(503);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
    expect(vi.mocked(f.ctx.storage.readFiles).mock.calls.flatMap((c) => c[0])).not.toContain(
      'tooltips/2.json',
    );
  });

  it.each([
    null,
    {},
    { ...proof, kind: 'variables', name: 'Damage', occupiedBy: id, localClash: true },
    { ...proof, complete: false },
    { ...proof, sources: { ...sources, aliases: null } },
  ])('fails closed on absent or malformed clash evidence %j', async (value) => {
    const f = await fixture(),
      locations = await namePaths('variables', 'Damage');
    if (value === null) f.files.delete(locations.proof);
    else f.files.set(locations.proof, value);
    expect((await f.call()).status).toBe(503);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });

  it('returns conflict for expected-head/revision races, including CAS, without retrying', async () => {
    const f = await fixture();
    expect((await f.call(edit, { expectedHead: 'd'.repeat(40) })).status).toBe(409);
    expect((await f.call({ ...edit, revision: 'old' })).status).toBe(409);
    vi.mocked(f.ctx.storage.commit).mockRejectedValueOnce(new RefRace());
    expect((await f.call()).data.kind).toBe('conflict');
    expect(f.ctx.storage.commit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { operation: 'create', kind: 'variables', name: 'bad-name', lang: 'en', body: 'x' },
    { operation: 'create', kind: 'variables', name: 'Zb1wx', lang: 'en', body: 'x' },
  ] as Mutation[])('refuses invalid/protected names %j', async (mutation) => {
    expect((await (await fixture()).call(mutation)).status).toBe(422);
  });

  it.each(['two\nlines', ' spaces ', 'empty', 'x /* hidden */', 'x // hidden'])(
    'refuses non-round-tripping variable body %j',
    async (value) => {
      expect((await (await fixture()).call({ ...edit, body: value })).status).toBe(422);
    },
  );

  it('refuses empty and breakout title bodies, protected arrow edits, and duplicate claims', async () => {
    const f = await fixture();
    await f.admit('Label', null, 'titles');
    for (const value of ['', 'first\n)\nrest'])
      expect(
        (
          await f.call({
            operation: 'create',
            kind: 'titles',
            name: 'Label',
            lang: 'en',
            body: value,
          })
        ).status,
      ).toBe(422);
    f.files.set(paths.entry(id), { ...entry, name: 'e' });
    await f.admit('e');
    expect((await f.call()).status).toBe(422);
    const locations = await f.admit('Fresh', null);
    f.files.set(locations.claim, { id: 'g_other123', kind: 'variables', name: 'Fresh' });
    expect(
      (
        await f.call({
          operation: 'create',
          kind: 'variables',
          name: 'Fresh',
          lang: 'en',
          body: 'x',
        })
      ).status,
    ).toBe(409);
  });

  it('checks current roles and translator language on every call', async () => {
    const f = await fixture();
    f.ctx.access = { login: 'translator', role: 'translator', languages: ['de'] };
    expect((await f.call()).status).toBe(403);
    expect((await f.call({ ...edit, lang: 'fr' })).status).toBe(403);
    expect((await f.call({ ...edit, lang: 'de' })).status).toBe(200);
    expect(
      (
        await f.call({
          operation: 'create',
          kind: 'variables',
          name: 'Fresh',
          lang: 'de',
          body: 'x',
        })
      ).status,
    ).toBe(403);
    f.ctx.access = { login: 'trial', role: 'trial' };
    expect((await f.call({ operation: 'rename', id, revision: 'r1', name: 'Other' })).status).toBe(
      403,
    );
    expect((await f.call(ack)).status).toBe(409); // Pending blocks even a previously saved row.
    f.files.set(paths.sync, current);
    expect((await f.call(ack)).status).toBe(403);
  });

  it('requires maintainer and fresh exhaustive zero-reference removal evidence, per language', async () => {
    const f = await fixture(),
      remove: Mutation = { operation: 'remove', id, revision: 'r1', lang: 'en' };
    expect((await f.call(remove)).status).toBe(403);
    f.ctx.access.role = 'maintainer';
    expect((await f.call(remove)).status).toBe(503);
    const zero = {
      ...proof,
      id,
      revision: 'r1',
      lang: 'en',
      references: {
        authored: 0,
        effective: 0,
        live: 0,
        upcoming: 0,
        unresolved: 0,
        conservativeTitles: 0,
      },
    };
    for (const key of Object.keys(zero.references)) {
      f.files.set(paths.removal(id, 'en'), {
        ...zero,
        references: { ...zero.references, [key]: 1 },
      });
      expect((await f.call(remove)).status).toBe(503);
    }
    f.files.set(paths.removal(id, 'en'), { ...zero, lang: null });
    expect((await f.call(remove)).status).toBe(503);
    f.files.set(paths.removal(id, 'en'), zero);
    const result = await f.call(remove);
    expect(result.status).toBe(200);
    expect(result.data.value.entry.definitions).toEqual({});
    expect(result.data.value.status).toBe('sync-pending');
  });

  it('bounds requests, records, response pages, pending backlog, and route identities', async () => {
    const f = await fixture();
    expect((await f.call({ ...edit, body: 'x'.repeat(limits.requestBytes) })).status).toBe(413);
    expect((await f.call(edit, {}, `/globals/g_different/body`)).status).toBe(400);
    f.files.set(paths.sync, {
      version: 1,
      status: 'sync-pending',
      lastFailure: null,
      causeIds: Array.from({ length: limits.causes }, (_, i) => `cause${i}`),
      causeEntries: Object.fromEntries(
        Array.from({ length: limits.causes }, (_, i) => [`cause${i}`, id]),
      ),
    });
    expect((await f.call()).status).toBe(503);
    f.files.set(paths.sync, current);
    f.files.set(paths.entry(id), {
      ...entry,
      nameHistory: Array.from({ length: 10000 }, () => ({})),
    });
    expect((await f.call()).status).toBe(503);
    // The catalogue is the bundle's: the bare route reads nothing for anything but a create.
    const load = vi.fn(async () => f.ctx);
    for (const method of ['GET', 'HEAD', 'PUT'])
      expect(
        (await globalsHandler(new Request('https://local/globals', { method }), load)).status,
      ).toBe(405);
    expect(load).not.toHaveBeenCalled();
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });
});

describe('authoritative saved review acknowledgement and read', () => {
  it('stores a separate audited no-text-change decision with all three digests', async () => {
    const f = await fixture();
    const result = await f.call(ack);
    expect(result.status).toBe(200);
    expect(result.data.value.review.acknowledgement).toMatchObject({
      by: 'editor',
      contentDigest: digest,
      dependencyDigest: digest,
      impactDigest: digest,
      decision: 'no-text-change',
    });
    expect(vi.mocked(f.ctx.storage.commit).mock.calls[0][1]).toEqual({
      [paths.row('review1')]: expect.any(Object),
    });
  });

  it.each(['contentDigest', 'dependencyDigest', 'impactDigest'] as const)(
    'refuses stale %s',
    async (field) => {
      const f = await fixture();
      expect((await f.call({ ...ack, [field]: 'c'.repeat(64) })).status).toBe(409);
      expect(f.ctx.storage.commit).not.toHaveBeenCalled();
    },
  );

  it.each(['sync-pending', 'sync-failed'])('refuses %s rows', async (status) => {
    const f = await fixture();
    f.files.set(paths.sync, {
      version: 1,
      status,
      causeIds: ['cause1'],
      causeEntries: { cause1: id },
      lastFailure: 'Failed',
    });
    expect((await f.call(ack)).status).toBe(409);
  });

  it('refuses stale sources, incomplete/projected rows, and mismatched cause/consumer manifests', async () => {
    const f = await fixture();
    for (const row of [
      { ...f.row(), complete: false },
      { ...f.row(), projected: true },
      { ...f.row(), sources: { ...sources, live: 'd'.repeat(40) } },
      { ...f.row(), view: { ...f.row().view, consumer: { ...consumer, hash: 99 } } },
      {
        ...f.row(),
        review: {
          ...f.row().review,
          causes: [{ globalId: 'g_other123', beforeRevision: null, afterRevision: 'r1' }],
        },
      },
    ]) {
      f.files.set(paths.row('review1'), row);
      expect((await f.call(ack)).status).toBe(503);
    }
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });

  it('returns bounded entry/review pages, conservative path metadata, and browser-only projection rejection', async () => {
    const f = await fixture();
    f.files.set(paths.row('review2'), { ...f.row(), id: 'review2' });
    f.files.set(`globals/review-pages/${id}/p0.json`, {
      ...(f.files.get(`globals/review-pages/${id}/p0.json`) as object),
      ids: ['review1', 'review2'],
    });
    for (const path of [`/globals/${id}`, `/globals/${id}/reviews`]) {
      vi.mocked(f.ctx.storage.readFiles).mockClear();
      const response = await globalsHandler(new Request(`https://local${path}`), async () => f.ctx);
      // Sync, then the entry; or sync, the review page, and all its rows in ONE read.
      expect(f.ctx.storage.readFiles).toHaveBeenCalledTimes(path.endsWith('reviews') ? 3 : 2);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.value.status).toBe('current');
      if (path.endsWith('reviews')) expect(result.value.impacts[id]).toHaveLength(2);
      if (path.endsWith('reviews'))
        expect(result.value.impacts[id][0]).toMatchObject({
          line: null,
          path: null,
          direct: null,
          archived: true,
        });
    }
    expect((await f.call(edit, {}, `/globals/${id}/impact`)).status).toBe(404);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });
});

describe('S5 fail-closed integration guards', () => {
  it('requires current complete approval even with no pending causes', () => {
    for (const certificate of [
      undefined,
      {},
      { ...proof, consumer, causeIds: [], independent: false, approved: false },
    ])
      expect(() => assertGlobalsPublication(sources, current, certificate, consumer)).toThrow(
        /Sync pending/,
      );
    expect(() =>
      assertGlobalsPublication(
        sources,
        current,
        { ...proof, consumer, causeIds: [], independent: false, approved: true },
        consumer,
      ),
    ).not.toThrow();
  });

  it('blocks the destination while closure is unknown, allowing only exact independent certificates', () => {
    const sync = {
      version: 1,
      status: 'sync-pending',
      causeIds: ['cause1', 'cause2'],
      causeEntries: { cause1: id, cause2: id },
      lastFailure: null,
    };
    const certificate = {
      ...proof,
      consumer,
      causeIds: sync.causeIds,
      independent: true,
      approved: true,
    };
    expect(() => assertGlobalsPublication(sources, sync, certificate, consumer)).not.toThrow();
    for (const bad of [
      { ...certificate, independent: false },
      { ...certificate, causeIds: ['cause1'] },
      { ...certificate, causeIds: ['cause1', 'cause1'] },
      { ...certificate, consumer: { ...consumer, destination: 'upcoming' } },
      { ...certificate, sources: { ...sources, authored: 'd'.repeat(40) } },
      { ...certificate, complete: false },
    ])
      expect(() => assertGlobalsPublication(sources, sync, bad, consumer)).toThrow(/Sync pending/);
    expect(() => assertGlobalsPublication(sources, null, certificate, consumer)).toThrow();
  });

  it('refuses raw aggregate saves/imports/history/batches', () => {
    expect(() => assertNoRawGlobalMutation([42])).not.toThrow();
    for (const hashes of [[2], [3], [42, 2, 3]])
      expect(() => assertNoRawGlobalMutation(hashes)).toThrow();
  });
});

describe('raw file bounds and acknowledgement capacity regressions', () => {
  it('rejects whitespace-padded oversized sync, claim, and page-entry files before decoding or JSON parsing', async () => {
    for (const target of [
      paths.sync,
      (await namePaths('variables', 'Damage')).claim,
      paths.entry(id),
    ]) {
      const f = await fixture(),
        original = vi.mocked(f.ctx.storage.readFiles).getMockImplementation()!;
      const bytes = new TextEncoder().encode(' '.repeat(2_000_000) + JSON.stringify(current));
      vi.mocked(f.ctx.storage.readFiles).mockImplementation(async (...args) =>
        (await original(...args)).map((file, i) =>
          args[0][i] === target ? { sha: head, bytes } : file,
        ),
      );
      const decode = vi.spyOn(TextDecoder.prototype, 'decode');
      try {
        const response = target.includes('/names/')
          ? await f.call()
          : {
              status: (
                await globalsHandler(new Request(`https://local/globals/${id}`), async () => f.ctx)
              ).status,
            };
        expect(response.status).toBe(503);
        expect(decode.mock.calls.some(([input]) => input === bytes)).toBe(false);
        expect(f.ctx.storage.commit).not.toHaveBeenCalled();
        expect(f.ctx.storage.readFiles).toHaveBeenCalledWith(
          expect.any(Array),
          head,
          target.includes('/entries/') || target === paths.sync
            ? limits.entryBytes
            : limits.metadataBytes,
          limits.fileBytes,
        );
      } finally {
        decode.mockRestore();
      }
    }
  });

  it('checks a whole batch byte cap before decoding its first file and rejects invalid UTF-8/JSON', async () => {
    const f = await fixture();
    vi.mocked(f.ctx.storage.readFiles).mockResolvedValue(
      Array.from({ length: 3 }, () => ({ sha: head, bytes: new Uint8Array(30_000) })),
    );
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      await expect(readGlobalFiles(f.ctx.storage, ['one', 'two', 'three'], head)).rejects.toThrow(
        /byte limit/,
      );
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
    for (const bytes of [new Uint8Array([255]), new TextEncoder().encode('{')]) {
      vi.mocked(f.ctx.storage.readFiles).mockResolvedValue([{ sha: head, bytes }]);
      await expect(readGlobalFiles(f.ctx.storage, ['one'], head)).rejects.toThrow(
        /encoding or JSON/,
      );
    }
  });

  it('refuses rows without audit capacity, and keeps a near-limit acknowledged row readable', async () => {
    const f = await fixture();
    const large = (target: number) => {
      const row = f.row();
      row.view.beforeSource = 'x'.repeat(8192);
      row.view.afterSource = 'y'.repeat(target - globalFileBytes(row));
      expect(globalFileBytes(row)).toBe(target);
      return row;
    };
    f.files.set(paths.row('review1'), large(16_300));
    expect((await f.call(ack)).status).toBe(503);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
    f.files.set(paths.row('review1'), large(14_000));
    expect((await f.call(ack)).status).toBe(200);
    expect(globalFileBytes(f.files.get(paths.row('review1')))).toBeLessThanOrEqual(
      limits.entryBytes,
    );
    const response = await globalsHandler(
      new Request(`https://local/globals/${id}/reviews`),
      async () => f.ctx,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.value.impacts[id][0].review.acknowledgement.decision).toBe('no-text-change');
  });
});

describe('S3 snapshot and explicit durable-cause retry contract', () => {
  async function pendingFixture() {
    const f = await fixture();
    const saved = await f.call();
    f.ctx.head = saved.data.value.head;
    const causeIds: string[] = saved.data.value.causeIds;
    const retry = async (overrides: Record<string, unknown> = {}) => {
      const response = await globalsHandler(
        new Request(`https://local/globals/${id}/retry`, {
          method: 'POST',
          body: JSON.stringify({ expectedHead: f.ctx.head, id, causeIds, ...overrides }),
        }),
        async () => f.ctx,
      );
      return { status: response.status, data: await response.json() };
    };
    vi.mocked(f.ctx.storage.commit).mockClear();
    return { ...f, causeIds, retry };
  }

  it('returns per-entry and destination sync maps and sanitized failures on explicit refresh', async () => {
    const f = await pendingFixture();
    const state = f.files.get(paths.sync) as Record<string, unknown>;
    const secret = 'private tooltip text and token=not-for-the-client';
    f.files.set(paths.sync, { ...state, status: 'sync-failed', lastFailure: secret });
    const response = await globalsHandler(
      new Request(`https://local/globals/${id}`),
      async () => f.ctx,
    );
    const result = await response.json();
    expect(result.kind).toBe('ok');
    expect(result.value.sync[id]).toEqual({
      status: 'sync-failed',
      causeIds: f.causeIds,
      lastFailure: 'Sync failed. Retry sync.',
    });
    expect(result.value.destinationSync.live).toEqual(result.value.sync[id]);
    expect(result.value.destinationSync.upcoming).toEqual(result.value.sync[id]);
    expect(JSON.stringify(result)).not.toContain(secret);
    // The bundle's copy (publisher) uses the same filter: same view, no producer details.
    const bundled = publicGlobalSync(syncSchema.parse(f.files.get(paths.sync)));
    expect(bundled).toEqual({
      status: 'sync-failed',
      causeIds: f.causeIds,
      lastFailure: 'Sync failed. Retry sync.',
      causeEntries: Object.fromEntries(f.causeIds.map((cause) => [cause, id])),
    });
    expect(JSON.stringify(bundled)).not.toContain(secret);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });

  it('requeues exact durable causes in one expected-head commit without changing causes, definitions, or approvals', async () => {
    const f = await pendingFixture();
    const before = structuredClone(f.files.get(`globals/causes/${f.causeIds[0]}.json`));
    const result = await f.retry();
    expect(result.status).toBe(200);
    expect(result.data.value.sync[id]).toMatchObject({
      status: 'sync-pending',
      causeIds: f.causeIds,
    });
    expect(result.data.value.entries[0].id).toBe(id);
    expect(result.data.value.destinationSync.live.status).toBe('sync-pending');
    const changes = vi.mocked(f.ctx.storage.commit).mock.calls[0][1];
    expect(Object.keys(changes).sort()).toEqual(
      [`globals/retries/${result.data.value.retryId}.json`, paths.sync].sort(),
    );
    expect(changes[`globals/retries/${result.data.value.retryId}.json`]).toMatchObject({
      globalId: id,
      expectedHead: f.ctx.head,
      sources,
      causeIds: f.causeIds,
      by: 'editor',
    });
    expect(f.files.get(`globals/causes/${f.causeIds[0]}.json`)).toEqual(before);
    expect(f.ctx.storage.commit).toHaveBeenCalledTimes(1);
  });

  it('refuses stale heads, unknown/duplicate/mismatched causes, and missing durable cause records', async () => {
    const f = await pendingFixture();
    expect((await f.retry({ expectedHead: head })).status).toBe(409);
    expect((await f.retry({ causeIds: ['unknown'] })).status).toBe(409);
    expect((await f.retry({ causeIds: [f.causeIds[0], f.causeIds[0]] })).status).toBe(400);
    expect((await f.retry({ id: 'g_other123' })).status).toBe(400);
    const path = `globals/causes/${f.causeIds[0]}.json`,
      original = f.files.get(path);
    f.files.delete(path);
    expect((await f.retry()).status).toBe(503);
    f.files.set(path, { ...(original as object), globalId: 'g_other123' });
    expect((await f.retry()).status).toBe(409);
    f.files.set(path, { ...(original as object), id: 'wrong' });
    expect((await f.retry()).status).toBe(409);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });

  it('rechecks retry permissions/languages, preserves pending on CAS conflict, and refuses cleared causes', async () => {
    const f = await pendingFixture();
    f.ctx.access = { login: 'translator', role: 'translator', languages: ['de'] };
    expect((await f.retry()).status).toBe(403);
    f.ctx.access = { login: 'trial', role: 'trial' };
    const path = `globals/causes/${f.causeIds[0]}.json`,
      original = f.files.get(path) as object;
    f.files.set(path, { ...original, operation: 'remove' });
    expect((await f.retry()).status).toBe(403);
    f.ctx.access.role = 'maintainer';
    vi.mocked(f.ctx.storage.commit).mockRejectedValueOnce(new RefRace());
    const syncBefore = structuredClone(f.files.get(paths.sync));
    expect((await f.retry()).status).toBe(409);
    expect(f.files.get(paths.sync)).toEqual(syncBefore);
    f.files.set(paths.sync, current);
    expect((await f.retry()).status).toBe(409);
  });

  it('distinguishes current entry state from destination-wide pending protection', async () => {
    const f = await fixture();
    f.files.set(paths.sync, {
      version: 1,
      status: 'sync-pending',
      causeIds: ['other'],
      causeEntries: { other: 'g_other123' },
      lastFailure: null,
    });
    const response = await globalsHandler(
      new Request(`https://local/globals/${id}`),
      async () => f.ctx,
    );
    const result = await response.json();
    expect(result.value.sync[id]).toEqual({ status: 'current', causeIds: [] });
    expect(result.value.destinationSync.live).toEqual({
      status: 'sync-pending',
      causeIds: ['other'],
    });
    expect((await f.call(ack)).status).toBe(409);
  });
});

describe('root rulings N1(a), R5, and R7', () => {
  const create: Mutation = {
    operation: 'create',
    kind: 'variables',
    name: 'NeverUsedBefore',
    lang: 'en',
    body: 'unsaved body',
  };

  it.each(['missing', 'stale'] as const)(
    'queues a %s proof for a never-used name without claiming the create saved',
    async (state) => {
      const f = await fixture(),
        locations = await namePaths('variables', create.name);
      if (state === 'stale') {
        await f.admit(create.name, null);
        f.files.set(locations.proof, {
          ...(f.files.get(locations.proof) as object),
          sources: { ...sources, authored: 'e'.repeat(40) },
        });
      } else expect(f.files.has(locations.proof)).toBe(false);
      const syncBefore = structuredClone(f.files.get(paths.sync));
      const result = await f.call(create);
      expect(result.status).toBe(202);
      expect(result.data).toMatchObject({
        kind: 'retry',
        message: 'Sync pending',
        status: 'sync-pending',
        mutationCompleted: false,
      });
      expect(result.data.entry).toBeUndefined();
      const changes = vi.mocked(f.ctx.storage.commit).mock.calls[0][1];
      const path = `globals/retries/${result.data.proofRequestId}.json`;
      expect(Object.keys(changes)).toEqual([path]);
      expect(nameProofRequestSchema.parse(changes[path])).toMatchObject({
        type: 'name-proof',
        operation: 'create',
        kind: 'variables',
        name: create.name,
        globalId: null,
        revision: null,
        expectedHead: head,
        sources,
        by: 'editor',
      });
      expect(JSON.stringify(changes)).not.toContain(create.body);
      expect(f.files.get(paths.sync)).toEqual(syncBefore);
      expect(f.files.has(locations.claim)).toBe(false);
      // S4 supplies the requested certificate; an explicit later retry can then save normally.
      await f.admit(create.name, null);
      f.ctx.head = result.data.head;
      const saved = await f.call(create);
      expect(saved.status).toBe(200);
      expect(saved.data.value.entry.name).toBe(create.name);
      expect(saved.data.value.causeIds).toHaveLength(1);
    },
  );

  it.each(['missing', 'stale'] as const)(
    'queues a %s rename proof without an intent, reservation, or rewritten entry',
    async (state) => {
      const f = await fixture(),
        name = 'NewRenameName';
      if (state === 'stale') {
        await f.admit(name, null);
        f.ctx.sources.generator = 'd'.repeat(40);
      }
      const result = await f.call({ operation: 'rename', id, revision: 'r1', name });
      expect(result.status).toBe(202);
      expect(result.data).toMatchObject({
        kind: 'retry',
        message: 'Sync pending',
        mutationCompleted: false,
        renameCompleted: false,
      });
      const changes = vi.mocked(f.ctx.storage.commit).mock.calls[0][1];
      expect(Object.keys(changes)).toEqual([`globals/retries/${result.data.proofRequestId}.json`]);
      expect(Object.values(changes)[0]).toMatchObject({
        operation: 'rename',
        globalId: id,
        revision: 'r1',
        name,
      });
      expect(f.files.get(paths.entry(id))).toEqual(entry);
      expect(f.files.has((await namePaths('variables', name)).claim)).toBe(false);
    },
  );

  it('never queues malformed proofs, invalid bodies, forbidden roles, stale revisions/heads, or CAS failures as successes', async () => {
    const f = await fixture(),
      locations = await namePaths('variables', create.name);
    f.files.set(locations.proof, {});
    expect((await f.call(create)).status).toBe(503);
    f.files.delete(locations.proof);
    expect((await f.call({ ...create, body: 'invalid\nbody' })).status).toBe(422);
    expect((await f.call(create, { expectedHead: 'e'.repeat(40) })).status).toBe(409);
    expect(
      (await f.call({ operation: 'rename', id, revision: 'old', name: create.name })).status,
    ).toBe(409);
    f.ctx.access = { login: 'translator', role: 'translator', languages: ['de'] };
    expect((await f.call(create)).status).toBe(403);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
    f.ctx.access.role = 'editor';
    vi.mocked(f.ctx.storage.commit).mockRejectedValueOnce(new RefRace());
    const result = await f.call(create);
    expect(result.status).toBe(409);
    expect(result.data.kind).toBe('conflict');
    expect(f.files.has(locations.claim)).toBe(false);
    expect(f.ctx.storage.commit).toHaveBeenCalledTimes(1);
  });

  it('returns invalid rather than retry for permanent request/admission and catalog limits', async () => {
    const f = await fixture();
    const tooLong = await f.call({ ...edit, body: 'x'.repeat(limits.body + 1) });
    expect(tooLong).toMatchObject({ status: 422, data: { kind: 'invalid' } });
    const tooLarge = await f.call({ ...edit, body: 'x'.repeat(limits.requestBytes) });
    expect(tooLarge).toMatchObject({ status: 413, data: { kind: 'invalid' } });
    await f.admit(create.name, null);
    f.files.set('globals/catalog.json', { version: 1, lastPage: 99999 });
    f.files.set(paths.page('p99999'), {
      version: 1,
      ids: [id, 'g_second12', 'g_third123'],
      nextCursor: null,
    });
    expect(await f.call(create)).toMatchObject({
      status: 422,
      data: { kind: 'invalid', message: 'Global catalog is full' },
    });
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });

  it('fits the largest valid entry read in one bounded response (the paged list could not)', async () => {
    const f = await fixture();
    const ids = ['a', 'b', 'c'].map((letter) => `g_${letter.repeat(80)}`);
    for (const entryId of ids) {
      const value = {
        ...entry,
        id: entryId,
        nameHistory: [{ name: 'Former', revision: 'r0', by: '', at: '2026-11-15T00:00:00Z' }],
      };
      value.nameHistory[0].by = 'x'.repeat(limits.entryBytes - globalFileBytes(value));
      expect(globalFileBytes(value)).toBe(limits.entryBytes);
      f.files.set(paths.entry(entryId), value);
    }
    f.files.set(paths.page('p0'), { version: 1, ids, nextCursor: null });
    const causes = Array.from({ length: limits.causes }, (_, i) => String(i).padEnd(80, 'x'));
    f.files.set(paths.sync, {
      version: 1,
      status: 'sync-failed',
      causeIds: causes,
      causeEntries: Object.fromEntries(causes.map((cause, i) => [cause, ids[i % 3]])),
      lastFailure: 'failed',
    });
    f.ctx.destinations = Array.from({ length: 4 }, (_, i) => String(i).padEnd(80, 'd'));
    const response = await globalsHandler(
      new Request(`https://local/globals/${ids[0]}`),
      async () => f.ctx,
    );
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeLessThan(limits.fileBytes);
    expect(f.ctx.storage.commit).not.toHaveBeenCalled();
  });

  it.each(['edited', 'no-text-change'] as const)(
    'refuses to relabel an existing equal-digest %s audit',
    async (decision) => {
      const f = await fixture(),
        row = f.row();
      const audit = {
        by: 'alice',
        at: '2026-11-15T00:00:00Z',
        contentDigest: digest,
        dependencyDigest: digest,
        impactDigest: digest,
        decision,
      };
      f.files.set(paths.row('review1'), {
        ...row,
        review: { ...row.review, acknowledgement: audit },
      });
      expect(await f.call(ack)).toMatchObject({ status: 409, data: { kind: 'conflict' } });
      expect(
        (f.files.get(paths.row('review1')) as { review: { acknowledgement: unknown } }).review
          .acknowledgement,
      ).toEqual(audit);
      expect(f.ctx.storage.commit).not.toHaveBeenCalled();
    },
  );

  it('allows a fresh audit after an earlier acknowledgement becomes stale', async () => {
    const f = await fixture(),
      row = f.row();
    f.files.set(paths.row('review1'), {
      ...row,
      review: {
        ...row.review,
        acknowledgement: {
          by: 'alice',
          at: '2026-11-15T00:00:00Z',
          contentDigest: digest,
          dependencyDigest: digest,
          impactDigest: 'c'.repeat(64),
          decision: 'edited',
        },
      },
    });
    expect((await f.call(ack)).status).toBe(200);
  });

  it('preserves absent migration ancestry when editing post-migration definitions and adding translations', async () => {
    const f = await fixture(),
      fresh = structuredClone(entry);
    delete fresh.definitions.en!.provenance;
    f.files.set(paths.entry(id), fresh);
    const edited = await f.call(edit);
    expect(edited.status).toBe(200);
    expect(edited.data.value.entry.definitions.en.provenance).toBeUndefined();
    const translated = await f.call({
      ...edit,
      revision: edited.data.value.entry.revision,
      lang: 'de',
      body: 'neu',
    });
    expect(translated.status).toBe(200);
    expect(translated.data.value.entry.definitions.de.provenance).toBeUndefined();
  });
});
