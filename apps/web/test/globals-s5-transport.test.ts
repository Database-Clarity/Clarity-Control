import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobalsService, type GlobalsTransport } from '../src/services/globals';
import { assertNoGlobalAggregates, globalAggregateRefusal } from '../src/services/globalsFlag';
import { fixtureHead, globalFixtureSnapshot } from './globals-entries-fixture';

const entry = globalFixtureSnapshot.entries[0];
const row = globalFixtureSnapshot.impacts.g_damage0001[0];
const header = (
  status: 'current' | 'sync-pending' | 'sync-failed' = 'current',
  causeIds: string[] = [],
) => ({
  head: fixtureHead(1),
  status,
  causeIds,
  lastFailure: null,
});
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('authenticated globals transport', () => {
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
    fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const transport = async () =>
    (await import('../src/services/globalsHttp')).createGlobalsHttpTransport();

  it('normalizes the S2B review page and retry receipt into the S3 shapes', async () => {
    fetch.mockResolvedValueOnce(
      reply({
        kind: 'ok',
        value: { ...header(), impacts: { [entry.id]: [row] }, nextCursor: null },
      }),
    );
    const page = await (await transport()).reviews(entry.id, 'p0');
    expect(page).toMatchObject({ kind: 'ok', value: { version: 1, consumers: [row] } });
    expect(fetch.mock.calls[0][0]).toBe(
      `https://worker.example/globals/${entry.id}/reviews?cursor=p0`,
    );
    expect(fetch.mock.calls[0][1].credentials).toBe('omit');

    fetch.mockResolvedValueOnce(
      reply({ kind: 'ok', value: { ...header('sync-pending', ['c1']), entries: [entry] } }),
    );
    const retried = await (
      await transport()
    ).retrySync({ expectedHead: fixtureHead(1), id: entry.id, causeIds: ['c1'] });
    expect(retried).toMatchObject({ kind: 'ok', value: { entry, status: 'sync-pending' } });
    expect(fetch.mock.calls[1][1].method).toBe('POST');
  });

  it('answers Sync pending once for a 503 or a queued name proof, never retrying', async () => {
    fetch.mockResolvedValueOnce(
      reply({ kind: 'retry', message: 'Sync pending: source proof is stale' }, 503),
    );
    const mutation = {
      expectedHead: fixtureHead(1),
      mutation: {
        operation: 'edit' as const,
        id: entry.id,
        revision: 'r1',
        lang: 'en' as const,
        body: 'x',
      },
    };
    expect(await (await transport()).mutate(mutation)).toEqual({
      kind: 'retry',
      message: 'Sync pending: source proof is stale',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://worker.example/globals/${entry.id}/body`);

    fetch.mockResolvedValueOnce(
      reply(
        { kind: 'retry', message: 'Sync pending', status: 'sync-pending', head: fixtureHead(2) },
        202,
      ),
    );
    expect(
      await (
        await transport()
      ).mutate({
        expectedHead: fixtureHead(1),
        mutation: { operation: 'create', kind: 'variables', name: 'Fresh', lang: 'en', body: '1' },
      }),
    ).toEqual({ kind: 'retry', message: 'Sync pending' });
    expect(fetch.mock.calls[1][0]).toBe('https://worker.example/globals');

    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = await (await transport()).entry(entry.id);
    expect(offline.kind).toBe('retry');
    expect(offline.kind !== 'ok' && offline.message).toMatch(/^Sync pending: /);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reads the W history pages and one version by commit', async () => {
    const commit = 'c'.repeat(40);
    fetch.mockResolvedValueOnce(
      reply({
        kind: 'ok',
        value: {
          head: fixtureHead(1),
          page: 2,
          commits: [{ commit, author: 'A', login: 'a', avatar: null, date: null, message: 'Save' }],
        },
      }),
    );
    expect((await (await transport()).history(entry.id, 2)).kind).toBe('ok');
    expect(fetch.mock.calls[0][0]).toBe(
      `https://worker.example/globals/${entry.id}/history?page=2`,
    );
    fetch.mockResolvedValueOnce(
      reply({ kind: 'ok', value: { head: fixtureHead(1), commit, entry } }),
    );
    expect(await (await transport()).historyVersion(entry.id, commit)).toMatchObject({
      kind: 'ok',
      value: { entry },
    });
    expect(fetch.mock.calls[1][0]).toBe(
      `https://worker.example/globals/${entry.id}/history?commit=${commit}`,
    );
  });

  it('refuses oversized, malformed, and signed-out responses before using them', async () => {
    fetch.mockResolvedValueOnce(
      new Response(`{"kind":"ok","value":"${'x'.repeat(70_000)}"}`, { status: 200 }),
    );
    expect(await (await transport()).list('p0')).toEqual({
      kind: 'invalid',
      message: 'The globals response is too large.',
    });
    fetch.mockResolvedValueOnce(reply({ kind: 'ok', value: { ...header(), entries: [{}] } }));
    expect((await (await transport()).list('p0')).kind).toBe('invalid');
    fetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    expect((await (await transport()).list('p0')).kind).toBe('forbidden');
  });
});

describe('stale rename intents', () => {
  it('reads "not applied" after a current refresh that kept the old name, then clears', async () => {
    let status: 'sync-pending' | 'current' = 'current';
    const page = () => ({
      kind: 'ok' as const,
      value: {
        ...header(status, status === 'current' ? [] : ['c1']),
        version: 1 as const,
        entries: [entry],
        nextCursor: null,
      },
    });
    const transport: GlobalsTransport = {
      list: async () => page(),
      entry: async () => ({ kind: 'ok', value: { ...page().value, entry } }),
      reviews: async () => ({
        kind: 'ok',
        value: { ...page().value, consumers: [], nextCursor: null },
      }),
      mutate: async () => ({
        kind: 'ok',
        value: {
          ...header('sync-pending', ['c1']),
          version: 1,
          entry,
          renameCompleted: false,
          intentId: 'intent1',
        },
      }),
      retrySync: async () => ({ kind: 'invalid', message: 'unused' }),
    };
    const service = createGlobalsService(transport, { destinations: ['live'] });
    expect((await service.read()).kind).toBe('ok');
    const queued = await service.mutate({
      expectedHead: fixtureHead(1),
      mutation: { operation: 'rename', id: entry.id, revision: entry.revision, name: 'Harm' },
    });
    expect(queued.kind === 'ok' && queued.value.renameIntents?.[entry.id]).toMatchObject({
      name: 'Harm',
      status: 'queued',
    });
    status = 'current';
    const refused = await service.read();
    expect(refused.kind === 'ok' && refused.value.renameIntents?.[entry.id]).toMatchObject({
      name: 'Harm',
      status: 'not-applied',
    });
    const later = await service.read();
    expect(later.kind === 'ok' && later.value.renameIntents).toEqual({});
  });
});

describe('raw aggregate save refusal', () => {
  it('refuses hashes 2 and 3 only with globals on', () => {
    expect(() => assertNoGlobalAggregates([1, 2], true)).toThrow(globalAggregateRefusal);
    expect(() => assertNoGlobalAggregates([3], true)).toThrow(globalAggregateRefusal);
    expect(() => assertNoGlobalAggregates([1, 10], true)).not.toThrow();
    expect(() => assertNoGlobalAggregates([2, 3], false)).not.toThrow();
  });
});
