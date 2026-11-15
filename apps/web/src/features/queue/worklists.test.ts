// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { connectWorklists, loadWorklist, syncWorklists, useSavedWorklists } from './worklists';
import {
  applyWorklistOperation,
  type StoredWorklist,
} from '../../../../../packages/core/src/worklists';
import { useAuthStore } from '../../stores/auth';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiAuth', () => ({ apiRequest: api }));
const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
let row: StoredWorklist | null;
let revision: number;
let disconnect: () => void;
let writes: [string, string][];
const rev = () => String(revision).padStart(32, '0');
const reply = () =>
  Response.json({ worklist: row ? { id, ...row } : null, revision: row ? rev() : null });
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
beforeEach(async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  writes = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
      writes.push([key, value]);
    },
  });
  useAuthStore.setState({ user: null, token: null, loading: false });
  useSavedWorklists.setState({
    scope: 'anonymous',
    base: [],
    lists: [],
    ops: [],
    loaded: [],
    index: {},
    pending: false,
  });
  row = { name: 'A', hashes: [1] };
  revision = 1;
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/worklists')
      return Response.json({
        lists: row
          ? [{ id, name: row.name, count: row.hashes.length, revision: rev(), updatedAt: 1 }]
          : [],
      });
    if (!init) return reply();
    const input = JSON.parse(String(init.body));
    if (input.revision !== (row ? rev() : null)) return new Response('{}', { status: 409 });
    row = applyWorklistOperation(row, input.op);
    revision++;
    return reply();
  });
  disconnect = connectWorklists();
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as never });
  await settle();
});
afterEach(() => {
  disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('loads only metadata until opening and sends an add operation, not a snapshot', async () => {
  expect(useSavedWorklists.getState().loaded).toEqual([]);
  await loadWorklist(id);
  useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  await syncWorklists();
  expect(row!.hashes).toEqual([1, 2]);
  expect(useSavedWorklists.getState().pending).toBe(false);
  const write = api.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(write[1].body)).toEqual({
    op: { type: 'add', hashes: [2] },
    revision: '1'.padStart(32, '0'),
  });
});
it('refetches and replays only this tab operation after a conflict (F1)', async () => {
  await loadWorklist(id);
  useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  row = { name: 'A', hashes: [1, 3] };
  revision = 2;
  await syncWorklists();
  expect(row!.hashes).toEqual([1, 3, 2]);
  expect(useSavedWorklists.getState().lists[0]!.items.map((x) => x.hash)).toEqual([1, 3, 2]);
});
it('stops after the second conflict and retains the pending operation for Sync', async () => {
  await loadWorklist(id);
  useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  api.mockImplementation(async (path: string, init?: RequestInit) =>
    init
      ? new Response('{}', { status: 409 })
      : path === '/worklists'
        ? Response.json({ lists: [] })
        : reply(),
  );
  await syncWorklists();
  expect(useSavedWorklists.getState().pending).toBe(true);
  expect(useSavedWorklists.getState().notice).toContain('Use Sync');
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
});
it('receiving invalidation replaces server state and never publishes or writes', async () => {
  await loadWorklist(id);
  row = { name: 'Remote', hashes: [1, 3] };
  revision = 2;
  writes = [];
  const before = api.mock.calls.length;
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'clarity-worklists:v3:1:invalidate',
      newValue: JSON.stringify({ id, nonce: 'remote' }),
    }),
  );
  await settle();
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Remote');
  expect(writes).toEqual([]);
  expect(api.mock.calls.slice(before).every(([, init]) => !init)).toBe(true);
});
it('keeps offline operations ordered across account reconnect', async () => {
  await loadWorklist(id);
  useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  useSavedWorklists
    .getState()
    .change(useSavedWorklists.getState().lists.map((row) => ({ ...row, name: 'Renamed' })));
  const server = api.getMockImplementation()!;
  api.mockRejectedValue(new Error('offline'));
  await syncWorklists();
  expect(useSavedWorklists.getState().ops.map((x) => x.op.type)).toEqual(['add', 'rename']);
  useAuthStore.setState({ user: null });
  api.mockImplementation(server);
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as never });
  await settle();
  await syncWorklists();
  expect(row).toEqual({ name: 'Renamed', hashes: [1, 2] });
});
it('explicit Sync refreshes new remote lists without loading entries', async () => {
  row = null;
  await syncWorklists(true);
  expect(useSavedWorklists.getState().lists).toEqual([]);
  row = { name: 'New', hashes: [3] };
  revision++;
  await syncWorklists(true);
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('New');
});

it.each(['add', 'rename'])(
  'two real tabs converge after concurrent %s with zero receiving writes (F4)',
  async (kind) => {
    disconnect();
    const listeners: EventListener[] = [];
    const original = window.addEventListener.bind(window);
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListener,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'storage') listeners.push(listener);
      original(type, listener, options);
    }) as typeof window.addEventListener);
    async function makeTab() {
      vi.resetModules();
      sessionStorage.clear();
      const auth = await import('../../stores/auth');
      const store = await import('./worklists');
      auth.useAuthStore.setState({
        user: { id: 1, login: 'one', role: 'editor' } as never,
        loading: false,
        token: null,
      });
      const stop = store.connectWorklists();
      await settle();
      await store.loadWorklist(id);
      return { ...store, stop };
    }
    const a = await makeTab();
    const b = await makeTab();
    try {
      if (kind === 'add') {
        a.useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
        b.useSavedWorklists.getState().add(id, '', [{ hash: 3, name: 'Three' }]);
      } else {
        a.useSavedWorklists
          .getState()
          .change(a.useSavedWorklists.getState().lists.map((row) => ({ ...row, name: 'Alpha' })));
        b.useSavedWorklists
          .getState()
          .change(b.useSavedWorklists.getState().lists.map((row) => ({ ...row, name: 'Beta' })));
      }
      await a.syncWorklists();
      const signalA = writes.filter(([key]) => key.endsWith(':invalidate')).at(-1)!;
      writes = [];
      await listeners[1]!(new StorageEvent('storage', { key: signalA[0], newValue: signalA[1] }));
      await settle();
      expect(writes).toEqual([]);
      await b.syncWorklists();
      const signalB = writes.filter(([key]) => key.endsWith(':invalidate')).at(-1)!;
      writes = [];
      await listeners[0]!(new StorageEvent('storage', { key: signalB[0], newValue: signalB[1] }));
      await settle();
      const puts = api.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
      for (let n = 0; n < 100; n++)
        await listeners[n % 2]!(
          new StorageEvent('storage', { key: signalB[0], newValue: signalB[1] }),
        );
      await settle();
      expect(writes).toEqual([]);
      expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(puts);
      expect(a.useSavedWorklists.getState().lists).toEqual(b.useSavedWorklists.getState().lists);
      expect(row).toEqual(
        kind === 'add' ? { name: 'A', hashes: [1, 2, 3] } : { name: 'Beta', hashes: [1] },
      );
    } finally {
      a.stop();
      b.stop();
      spy.mockRestore();
    }
  },
);
