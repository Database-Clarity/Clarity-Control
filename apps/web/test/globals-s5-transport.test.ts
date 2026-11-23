import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canAcknowledgeGlobal,
  createGlobalsService,
  type GlobalsTransport,
} from '../src/services/globals';
import { assertNoGlobalAggregates, globalAggregateRefusal } from '../src/services/globalsFlag';
import { fixtureHead, globalFixtureSnapshot } from './globals-entries-fixture';
import {
  aggregateGlobalRoute,
  identityDefinitions,
  globalIdOf,
} from '../src/stores/globalIdentities';

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

  it('gates approval on the destination state sent by the Worker', async () => {
    const destination = 'converter-v2-test';
    const consumer = { ...row.consumer, destination };
    const review = { ...row, consumer, review: { ...row.review, consumer } };
    const service = createGlobalsService(await transport(), {
      catalog: async () => ({ kind: 'ok', value: { ...header(), version: 1, entries: [entry] } }),
    });
    await service.read();
    for (const status of ['sync-pending', 'current'] as const) {
      const destinationSync = { [destination]: { status, causeIds: [] } };
      fetch.mockImplementation(async (url: string) =>
        reply({
          kind: 'ok',
          value: {
            ...header(),
            destinationSync,
            ...(url.includes('/reviews?')
              ? { impacts: { [entry.id]: [review] }, nextCursor: null }
              : { entry }),
          },
        }),
      );
      const result = await service.readEntry(entry.id);
      if (result.kind !== 'ok') throw new Error(result.message);
      expect(result.value.destinationSync).toEqual(destinationSync);
      expect(canAcknowledgeGlobal(result.value, entry.id, result.value.impacts[entry.id][0])).toBe(
        status === 'current',
      );
    }
  });

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

  it('reads an unreadable 2xx write reply as Sync pending and checks history versions', async () => {
    fetch.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(
      await (
        await transport()
      ).mutate({
        expectedHead: fixtureHead(1),
        mutation: { operation: 'edit', id: entry.id, revision: 'r1', lang: 'en', body: 'x' },
      }),
    ).toEqual({
      kind: 'retry',
      message: 'Sync pending: the save could not be confirmed; refresh first.',
    });
    const other = { ...entry, id: 'g_other00001' };
    fetch.mockResolvedValueOnce(
      reply({ kind: 'ok', value: { head: fixtureHead(1), commit: 'c'.repeat(40), entry: other } }),
    );
    expect((await (await transport()).historyVersion(entry.id, 'c'.repeat(40))).kind).toBe(
      'invalid',
    );
  });

  it('refuses oversized, malformed, and signed-out responses before using them', async () => {
    fetch.mockResolvedValueOnce(
      new Response(`{"kind":"ok","value":"${'x'.repeat(70_000)}"}`, { status: 200 }),
    );
    expect(await (await transport()).entry(entry.id)).toEqual({
      kind: 'invalid',
      message: 'The globals response is too large.',
    });
    fetch.mockResolvedValueOnce(reply({ kind: 'ok', value: { ...header(), entry: {} } }));
    expect((await (await transport()).entry(entry.id)).kind).toBe('invalid');
    fetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    expect((await (await transport()).entry(entry.id)).kind).toBe('forbidden');
  });
});

describe('stale rename intents', () => {
  it('settles a queued rename only from the Worker, never from a lagging bundle', async () => {
    // The bundle lags: it keeps saying "current" with the old name throughout.
    const bundle = {
      kind: 'ok' as const,
      value: { ...header('current'), version: 1 as const, entries: [entry] },
    };
    let status: 'sync-pending' | 'current' = 'sync-pending';
    let name = entry.name;
    const worker = () => ({
      ...header(status, status === 'current' ? [] : ['intent1']),
      version: 1 as const,
    });
    const saved = vi.fn();
    const transport: GlobalsTransport = {
      entry: async () => ({ kind: 'ok', value: { ...worker(), entry: { ...entry, name } } }),
      reviews: async () => ({
        kind: 'ok',
        value: { ...worker(), consumers: [], nextCursor: null },
      }),
      mutate: async () => ({
        kind: 'ok',
        value: {
          ...header('sync-pending', ['intent1']),
          version: 1,
          entry,
          renameCompleted: false,
          intentId: 'intent1',
        },
      }),
      retrySync: async () => ({ kind: 'invalid', message: 'unused' }),
    };
    const service = createGlobalsService(transport, {
      destinations: ['live'],
      catalog: async () => structuredClone(bundle),
      onEntrySaved: saved,
    });
    const intent = (result: Awaited<ReturnType<typeof service.read>>) =>
      result.kind === 'ok' ? result.value.renameIntents?.[entry.id] : 'failed';
    expect((await service.read()).kind).toBe('ok');
    const rename = {
      expectedHead: fixtureHead(1),
      mutation: {
        operation: 'rename' as const,
        id: entry.id,
        revision: entry.revision,
        name: 'Harm',
      },
    };
    expect(intent(await service.mutate(rename))).toMatchObject({ name: 'Harm', status: 'queued' });
    // The receipt's entry is unchanged: nothing for the saved overlay to keep.
    expect(saved).not.toHaveBeenCalled();
    // Refresh while the Worker is still pending: the bundle's "current" settles nothing.
    expect(intent(await service.read())).toMatchObject({ status: 'queued' });
    expect(intent(await service.readEntry(entry.id))).toMatchObject({ status: 'queued' });
    // Refused: the Worker is current and kept the old name.
    status = 'current';
    expect(intent(await service.read())).toMatchObject({ status: 'queued' });
    expect(intent(await service.readEntry(entry.id))).toMatchObject({ status: 'not-applied' });
    expect(intent(await service.read())).toMatchObject({ status: 'not-applied' });
    expect(intent(await service.readEntry(entry.id))).toMatchObject({ status: 'not-applied' });
    // Accepted: the Worker shows the new name; the intent clears without a report.
    status = 'sync-pending';
    expect(intent(await service.mutate(rename))).toMatchObject({ status: 'queued' });
    status = 'current';
    name = 'Harm';
    expect(intent(await service.read())).toMatchObject({ status: 'queued' });
    const reviews = vi.spyOn(transport, 'reviews').mockResolvedValue({
      kind: 'retry',
      message: 'Invalid global review page',
    });
    const accepted = await service.readEntry(entry.id, { reviews: false });
    expect(reviews).not.toHaveBeenCalled();
    expect(intent(accepted)).toBeUndefined();
    expect(accepted.kind === 'ok' && accepted.value.entries[0].name).toBe('Harm');
    expect(accepted.kind === 'ok' && accepted.value.impacts[entry.id]).toBeUndefined();
    expect(await service.readEntry(entry.id)).toMatchObject({ kind: 'retry' });
  });

  it('reports a cleared rename even while another change is pending', async () => {
    const page = () => ({
      kind: 'ok' as const,
      value: {
        ...header('sync-pending', ['unrelated']),
        version: 1 as const,
        entries: [entry],
      },
    });
    const transport: GlobalsTransport = {
      entry: async () => ({ kind: 'ok', value: { ...page().value, entry } }),
      reviews: async () => ({
        kind: 'ok',
        value: { ...page().value, consumers: [], nextCursor: null },
      }),
      mutate: async () => ({
        kind: 'ok',
        value: {
          ...header('sync-pending', ['intent1']),
          version: 1,
          entry,
          renameCompleted: false,
          intentId: 'intent1',
        },
      }),
      retrySync: async () => ({ kind: 'invalid', message: 'unused' }),
    };
    const service = createGlobalsService(transport, {
      destinations: ['live'],
      catalog: async () => page(),
    });
    expect((await service.read()).kind).toBe('ok');
    const queued = await service.mutate({
      expectedHead: fixtureHead(1),
      mutation: { operation: 'rename', id: entry.id, revision: entry.revision, name: 'Harm' },
    });
    expect(queued.kind === 'ok' && queued.value.renameIntents?.[entry.id]).toMatchObject({
      name: 'Harm',
      status: 'queued',
    });
    // A Refresh is a catalogue read then the opened entry's Worker read, which settles it.
    await service.read();
    const refused = await service.readEntry(entry.id);
    expect(refused.kind === 'ok' && refused.value.renameIntents?.[entry.id]).toMatchObject({
      name: 'Harm',
      status: 'not-applied',
    });
  });
});

describe('raw aggregate save refusal', () => {
  it('maps export catalogue identities and routes without confusing cross-kind names', () => {
    const identities = {
      g_export0001: {
        kind: 'exports' as const,
        name: 'Shared',
        definitions: { en: 'Export body' },
      },
      g_title00001: { kind: 'titles' as const, name: 'Shared', definitions: { en: 'Title body' } },
    };
    expect(identityDefinitions(identities).find((entry) => entry.kind === 'exports')).toMatchObject(
      { hash: 1, name: 'Shared' },
    );
    expect(globalIdOf(identities, 'exports', 'Shared')).toBe('g_export0001');
    expect(aggregateGlobalRoute('/globals/g_export0001', '?lang=de', identities)).toEqual({
      hash: 1,
      search: '?lang=de&global=Shared',
    });
  });
  it('refuses hashes 1, 2, and 3 only with globals on', () => {
    expect(() => assertNoGlobalAggregates([1, 2], true)).toThrow(globalAggregateRefusal);
    expect(() => assertNoGlobalAggregates([3], true)).toThrow(globalAggregateRefusal);
    expect(() => assertNoGlobalAggregates([1], true)).toThrow(globalAggregateRefusal);
    expect(() => assertNoGlobalAggregates([10], true)).not.toThrow();
    expect(() => assertNoGlobalAggregates([1, 2, 3], false)).not.toThrow();
  });
});
