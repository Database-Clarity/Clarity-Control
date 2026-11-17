import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { globalsHandler } from '../../worker/src/globals/handlers';
import { paths } from '../../worker/src/globals/model';
import { createGlobalsService } from '../src/services/globals';
import { globalFixtureSnapshot } from './globals-entries-fixture';

// Real S2B handler, real HTTP transport, real S3 service: two entries with failed causes.
const entries = structuredClone(globalFixtureSnapshot.entries);
const head = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const sources = Object.fromEntries(
  [
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
  ].map((key) => [key, key === 'fallback' || key === 'resolver' ? digest : head]),
);
const files = new Map<string, unknown>([
  [
    paths.sync,
    {
      version: 1,
      status: 'sync-failed',
      causeIds: ['causeA', 'causeB'],
      causeEntries: { causeA: entries[0].id, causeB: entries[1].id },
      lastFailure: 'drain failed',
    },
  ],
  [paths.page('p0'), { version: 1, ids: entries.map((entry) => entry.id), nextCursor: null }],
  ...entries.map((entry) => [paths.entry(entry.id), entry] as [string, unknown]),
  ...['causeA', 'causeB'].map(
    (id, index) =>
      [
        `globals/causes/${id}.json`,
        {
          version: 1,
          id,
          operation: 'edit',
          globalId: entries[index].id,
          lang: 'en',
          beforeSources: sources,
          expectedHead: head,
          at: '2026-01-01T00:00:00.000Z',
          by: 'editor',
          before: null,
          after: { path: paths.entry(entries[index].id), blob: head, revision: 'r1' },
          intentId: null,
        },
      ] as [string, unknown],
  ),
]);
const committed: Record<string, unknown>[] = [];
const ctx = {
  head,
  sources,
  access: { login: 'editor', role: 'editor' },
  user: { id: 1, login: 'editor' },
  repository: 'owner/data',
  destinations: ['live'],
  storage: {
    readFiles: async (list: string[]) =>
      list.map((path) =>
        files.has(path)
          ? { sha: head, bytes: new TextEncoder().encode(JSON.stringify(files.get(path))) }
          : null,
      ),
    commit: async (_head: string, changes: Record<string, unknown>) => {
      committed.push(changes);
      return 'c'.repeat(40);
    },
  },
};

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'https://worker.example');
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    globalsHandler(new Request(url, init), async () => ctx as never),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('retries only the selected entry’s own failed causes', async () => {
  vi.resetModules();
  const { createGlobalsHttpTransport } = await import('../src/services/globalsHttp');
  const service = createGlobalsService(createGlobalsHttpTransport(), { destinations: ['live'] });
  const read = await service.read();
  if (read.kind !== 'ok') throw new Error(read.message);
  expect(read.value.causeEntries).toEqual({ causeA: entries[0].id, causeB: entries[1].id });
  // Publication protection stays repository-wide: both entries read as failed.
  expect(read.value.sync[entries[1].id].status).toBe('sync-failed');
  const own = read.value.sync[entries[0].id].causeIds.filter(
    (cause) => read.value.causeEntries?.[cause] === entries[0].id,
  );
  expect(own).toEqual(['causeA']);
  const retried = await service.retrySync({ expectedHead: head, id: entries[0].id, causeIds: own });
  expect(retried.kind).toBe('ok');
  expect(retried.kind === 'ok' && retried.value.sync[entries[0].id].status).toBe('sync-pending');
  expect(committed).toHaveLength(1);
});
