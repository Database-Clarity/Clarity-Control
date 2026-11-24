import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

  it('reads the opened entry and accepts the existing Worker envelope', async () => {
    fetch.mockResolvedValueOnce(reply({ kind: 'ok', value: { ...header(), entry } }));
    expect(await (await transport()).entry(entry.id)).toEqual({
      kind: 'ok',
      value: { head: fixtureHead(1), causeIds: [], entry },
    });
    expect(fetch.mock.calls[0][0]).toBe(`https://worker.example/globals/${entry.id}`);
    expect(fetch.mock.calls[0][1].credentials).toBe('omit');
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
    expect(offline.kind !== 'ok' && offline.message).toContain('Could not reach the server');
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

  it('reports an unconfirmed write on an unreadable 2xx reply and checks history versions', async () => {
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
      message: 'The save could not be confirmed. Refresh to check.',
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
    };
    const service = createGlobalsService(transport, {
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
    const accepted = await service.readEntry(entry.id);
    expect(intent(accepted)).toBeUndefined();
    expect(accepted.kind === 'ok' && accepted.value.entries[0].name).toBe('Harm');
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
    };
    const service = createGlobalsService(transport, {
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
