import { describe, expect, it, vi } from 'vitest';
import { blobContent, blobSha, RefRace } from '../src/github.js';
import { globalsHandler, namePaths, type GlobalsContext } from '../src/globals/handlers.js';
import { assertGlobalsPublication, assertNoRawGlobalMutation } from '../src/globals/guards.js';
import { limits, paths, type Mutation, type Sources } from '../src/globals/model.js';
import type { GlobalRecord } from '../../../packages/core/src/globals/model.js';

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
const current = { version: 1, status: 'current', causeIds: [], lastFailure: null };
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
    github: {
      files: vi.fn(async (paths: readonly string[]) =>
        Promise.all(
          paths.map(async (path) =>
            files.has(path)
              ? {
                  sha: await blobSha(blobContent(files.get(path))),
                  value: structuredClone(files.get(path)),
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
  it('pins the observed blob ID instead of guessing the original file serialization', async () => {
    const f = await fixture(),
      actualRead = vi.mocked(f.ctx.github.files).getMockImplementation()!;
    vi.mocked(f.ctx.github.files).mockImplementation(async (selected, ref) =>
      (await actualRead(selected, ref)).map((file, i) =>
        file && selected[i] === paths.entry(id) ? { ...file, sha: 'f'.repeat(40) } : file,
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
    expect(f.ctx.github.commit).toHaveBeenCalledTimes(1);
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
    expect((await f.call({ ...edit, body: '字'.repeat(3000) })).status).toBe(503);
    expect(f.ctx.github.commit).not.toHaveBeenCalled();
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
    expect(f.ctx.github.commit).toHaveBeenCalledTimes(1);
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
    expect(second.data.value.lastFailure).toBe('Offline validation failed');
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

  it('creates a stable ID, source ancestry, claim, and bounded catalog entry atomically', async () => {
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
    expect(f.files.get(saved.definitions.en.provenance.path)).toEqual({
      text: 'var Fresh = empty',
    });
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
    expect(f.ctx.github.commit).not.toHaveBeenCalled();
    expect(vi.mocked(f.ctx.github.files).mock.calls.flatMap((c) => c[0])).not.toContain(
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
    expect(f.ctx.github.commit).not.toHaveBeenCalled();
  });

  it('returns conflict for expected-head/revision races, including CAS, without retrying', async () => {
    const f = await fixture();
    expect((await f.call(edit, { expectedHead: 'd'.repeat(40) })).status).toBe(409);
    expect((await f.call({ ...edit, revision: 'old' })).status).toBe(409);
    vi.mocked(f.ctx.github.commit).mockRejectedValueOnce(new RefRace());
    expect((await f.call()).data.kind).toBe('conflict');
    expect(f.ctx.github.commit).toHaveBeenCalledTimes(1);
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
    });
    expect((await f.call()).status).toBe(503);
    f.files.set(paths.sync, current);
    f.files.set(paths.entry(id), {
      ...entry,
      nameHistory: Array.from({ length: 10000 }, () => ({})),
    });
    expect((await f.call()).status).toBe(503);
    f.files.set(paths.page('p0'), { version: 1, ids: Array(4).fill(id), nextCursor: null });
    const response = await globalsHandler(new Request('https://local/globals'), async () => f.ctx);
    expect(response.status).toBe(503);
    expect(f.ctx.github.commit).not.toHaveBeenCalled();
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
    expect(vi.mocked(f.ctx.github.commit).mock.calls[0][1]).toEqual({
      [paths.row('review1')]: expect.any(Object),
    });
  });

  it.each(['contentDigest', 'dependencyDigest', 'impactDigest'] as const)(
    'refuses stale %s',
    async (field) => {
      const f = await fixture();
      expect((await f.call({ ...ack, [field]: 'c'.repeat(64) })).status).toBe(409);
      expect(f.ctx.github.commit).not.toHaveBeenCalled();
    },
  );

  it.each(['sync-pending', 'sync-failed'])('refuses %s rows', async (status) => {
    const f = await fixture();
    f.files.set(paths.sync, { version: 1, status, causeIds: ['cause1'], lastFailure: 'Failed' });
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
    expect(f.ctx.github.commit).not.toHaveBeenCalled();
  });

  it('returns bounded entry/review pages, conservative path metadata, and browser-only projection rejection', async () => {
    const f = await fixture();
    for (const path of ['/globals', `/globals/${id}`, `/globals/${id}/reviews`]) {
      const response = await globalsHandler(new Request(`https://local${path}`), async () => f.ctx);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.value.status).toBe('current');
      if (path.endsWith('reviews'))
        expect(result.value.consumers[0]).toMatchObject({
          line: null,
          path: null,
          direct: null,
          archived: true,
        });
    }
    expect((await f.call(edit, {}, `/globals/${id}/impact`)).status).toBe(422);
    expect(f.ctx.github.commit).not.toHaveBeenCalled();
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
