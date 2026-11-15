import { queueSources } from './sources';
import type { WorkQueue } from './model';
import type { EditorData } from '../../stores/data';
// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  connectWorklists,
  loadWorklist,
  syncWorklists,
  useSavedWorklists,
  copyPendingWorklist,
  discardPendingWorklist,
  pendingSessionRecovery,
} from './worklists';
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
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
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
    recovery: [],
    blocked: null,
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

it('retains pending additions and content when the server list was deleted, with explicit copy recovery (F6)', async () => {
  await loadWorklist(id);
  useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  row = null;
  revision++;
  await syncWorklists();
  expect(useSavedWorklists.getState().ops).toHaveLength(1);
  expect(useSavedWorklists.getState().blocked).toBe(id);
  expect(useSavedWorklists.getState().notice).toContain('deleted');
  const recovered = useSavedWorklists.getState().recovery.find((row) => row.id === id)!;
  expect(recovered.items.map((item) => item.hash)).toEqual([1, 2]);
  copyPendingWorklist(recovered, true);
  expect(useSavedWorklists.getState().ops[0]!.id).not.toBe(id);
  await syncWorklists();
  expect(row!.hashes).toEqual([1, 2]);
});
it('discovers other sessions for explicit independent copying without replaying or editing live queues (F7)', async () => {
  const other = 'clarity-worklists:v3:1:pending:other-session';
  const list = { id, name: 'Offline list', items: [{ hash: 7, name: 'Seven' }] };
  const backup = JSON.stringify({
    ops: [{ id, op: { type: 'create', name: list.name, hashes: [7] } }],
    recovery: [list],
  });
  localStorage.setItem(other, backup);
  localStorage.setItem('clarity-worklists:v3:2:pending:other-account', backup);
  const puts = api.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
  expect(pendingSessionRecovery()).toEqual([list]);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(puts);
  copyPendingWorklist(pendingSessionRecovery()[0]!);
  expect(useSavedWorklists.getState().ops[0]!.id).not.toBe(id);
  expect(localStorage.getItem(other)).toBe(backup);
  expect(useSavedWorklists.getState().lists.some((row) => row.name === 'Offline list')).toBe(true);
});
it('surfaces a limit rejection and permits cancelling only that list so later edits sync (F8)', async () => {
  await loadWorklist(id);
  useSavedWorklists.getState().add(null, 'Rejected create', []);
  const rejected = useSavedWorklists.getState().ops[0]!.id;
  useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  const server = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, init?: RequestInit) =>
    path.endsWith(rejected)
      ? Response.json({ error: 'An account can save up to 50 worklists' }, { status: 400 })
      : server(path, init),
  );
  await syncWorklists();
  expect(useSavedWorklists.getState().blocked).toBe(rejected);
  expect(useSavedWorklists.getState().notice).toContain('50 worklists');
  discardPendingWorklist(rejected);
  await syncWorklists();
  expect(row!.hashes).toEqual([1, 2]);
  expect(useSavedWorklists.getState().pending).toBe(false);
});
it('drains explicit Sync after a receiving index flight (F9)', async () => {
  await loadWorklist(id);
  let resolve!: (response: Response) => void;
  api.mockResolvedValueOnce(reply());
  api.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const old = Response.json({
    lists: [{ id, name: 'Old', count: 1, revision: rev(), updatedAt: 1 }],
  });
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'clarity-worklists:v3:1:invalidate',
      newValue: JSON.stringify({ id }),
    }),
  );
  await settle();
  await syncWorklists(true);
  row = { name: 'New remote', hashes: [1] };
  revision++;
  resolve(old);
  await settle();
  await vi.advanceTimersByTimeAsync(600);
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('New remote');
});

it('Rebuild reads authoritative remote membership, overlays own operations, and reports deletion (F10)', async () => {
  await loadWorklist(id);
  const data: EditorData = {
    items: Object.fromEntries(
      [1, 2, 3, 4].map((hash) => [
        hash,
        { hash, name: String(hash), icon: '', categoryId: 'perks', inGameDescription: '' },
      ]),
    ),
    aliases: {},
    categories: [],
    bundle: {
      tooltips: {},
      sourceCommit: 'fixture',
      generatedAt: '',
      permissions: { users: {} },
      pushed: {},
    },
  };
  const queue = { origin: { restore: { worklistId: id } }, items: [] } as unknown as WorkQueue;
  const rebuild = () => queueSources.custom.rebuild(queue, { data, user: null, decisions: {} }, {});
  row = { name: 'A', hashes: [1, 2] };
  revision++;
  expect((await rebuild()).map((item) => item.hash)).toEqual([1, 2]);
  row = { name: 'A', hashes: [2] };
  revision++;
  expect((await rebuild()).map((item) => item.hash)).toEqual([2]);
  useSavedWorklists.getState().add(id, '', [{ hash: 3, name: 'Three' }]);
  row = { name: 'A', hashes: [2, 4] };
  revision++;
  expect((await rebuild()).map((item) => item.hash)).toEqual([2, 4, 3]);
  expect(useSavedWorklists.getState().ops).toHaveLength(1);
  row = null;
  revision++;
  await expect(rebuild()).rejects.toThrow('deleted');
  expect(useSavedWorklists.getState().ops).toHaveLength(1);
});
it('keeps unsaved local creates usable when rebuilding before their first server save', async () => {
  useSavedWorklists.getState().add(null, 'Local only', [{ hash: 2, name: 'Two' }]);
  const pending = useSavedWorklists.getState().ops[0]!;
  const before = api.mock.calls.length;
  expect((await loadWorklist(pending.id, true)).items[0]!.hash).toBe(2);
  expect(api.mock.calls).toHaveLength(before);
});
it('cloned live documents keep independent durable operations, recoverable after both close (F11)', async () => {
  disconnect();
  sessionStorage.setItem('clarity-worklists-tab:v3', 'cloned-owner');
  async function documentStore() {
    vi.resetModules();
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
  const a = await documentStore();
  a.useSavedWorklists.getState().add(id, '', [{ hash: 2, name: 'Two' }]);
  const b = await documentStore();
  try {
    a.useSavedWorklists.getState().add(id, '', [{ hash: 4, name: 'Four' }]);
    b.useSavedWorklists.getState().add(id, '', [{ hash: 3, name: 'Three' }]);
    const backups = [];
    for (let n = 0; n < localStorage.length; n++) {
      const key = localStorage.key(n)!;
      if (key.startsWith('clarity-worklists:v3:1:pending:')) {
        const value = JSON.parse(localStorage.getItem(key)!);
        if (value.ops.length) backups.push(value);
      }
    }
    expect(backups).toHaveLength(2);
    expect(
      backups.map((value) => value.recovery[0].items.map((item: { hash: number }) => item.hash)),
    ).toEqual(
      expect.arrayContaining([
        [1, 2, 4],
        [1, 3],
      ]),
    );
  } finally {
    a.stop();
    b.stop();
  }
  const reopened = await documentStore();
  try {
    expect(
      reopened.pendingSessionRecovery().map((row) => row.items.map((item) => item.hash)),
    ).toEqual(
      expect.arrayContaining([
        [1, 2, 4],
        [1, 3],
      ]),
    );
  } finally {
    reopened.stop();
  }
});
