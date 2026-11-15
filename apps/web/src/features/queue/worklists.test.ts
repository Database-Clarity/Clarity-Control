// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  connectWorklists,
  loadWorklist,
  syncWorklists,
  retryWorklist,
  useSavedWorklists,
} from './worklists';
import {
  applyWorklistOperation,
  type StoredWorklist,
} from '../../../../../packages/core/src/worklists';
import { useAuthStore } from '../../stores/auth';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiAuth', () => ({ apiRequest: api }));
const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
let rows: Map<string, StoredWorklist>;
let revision: number;
let disconnect: () => void;
let server: (path: string, init?: RequestInit) => Promise<Response>;
const rev = () => String(revision).padStart(32, '0');
const reply = (key = id) =>
  Response.json({
    worklist: rows.has(key) ? { id: key, ...rows.get(key)! } : null,
    revision: rows.has(key) ? rev() : null,
  });
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const hashes = () =>
  useSavedWorklists
    .getState()
    .lists.find((row) => row.id === id)
    ?.items.map((item) => item.hash);
const add = (hash: number) =>
  useSavedWorklists.getState().add(id, '', [{ hash, name: String(hash) }]);
const sessionToken = `${btoa(JSON.stringify({ exp: 4102444800 }))}.test`;
beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  });
  sessionStorage.clear();
  sessionStorage.setItem('clarity-editor-session', sessionToken);
  useAuthStore.setState({ user: null, token: null, loading: false });
  rows = new Map([[id, { name: 'A', hashes: [1] }]]);
  revision = 1;
  api.mockReset();
  server = async (path, init) => {
    if (path === '/worklists')
      return Response.json({
        lists: [...rows].map(([key, row]) => ({
          id: key,
          name: row.name,
          count: row.hashes.length,
          revision: rev(),
          updatedAt: 1,
        })),
      });
    const key = decodeURIComponent(path.split('/').at(-1)!);
    if (init?.method !== 'PUT') return reply(key);
    const input = JSON.parse(String(init.body));
    if (input.revision !== (rows.has(key) ? rev() : null))
      return new Response('{}', { status: 409 });
    const next = applyWorklistOperation(rows.get(key) ?? null, input.op);
    if (next) rows.set(key, next);
    else rows.delete(key);
    revision++;
    return reply(key);
  };
  api.mockImplementation(server);
  disconnect = connectWorklists();
  useAuthStore.setState({
    user: { id: 1, login: 'one', role: 'editor' } as never,
    token: sessionToken,
  });
  await settle();
});
afterEach(async () => {
  disconnect();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('loads metadata on sign-in, lazily reads rows, sends one immediate op, and refreshes after acknowledgement', async () => {
  expect(useSavedWorklists.getState().loaded).toEqual([]);
  await loadWorklist(id);
  const saving = add(2);
  expect(hashes()).toEqual([1]);
  expect(useSavedWorklists.getState().saving).toHaveLength(1);
  expect(await saving).toBe(true);
  await settle();
  expect(hashes()).toEqual([1, 2]);
  expect(useSavedWorklists.getState().saving).toEqual([]);
  const writes = api.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1].body)).toEqual({
    op: { type: 'add', hashes: [2] },
    revision: '1'.padStart(32, '0'),
  });
  expect(api.mock.calls.at(-1)![0]).toBe('/worklists');
});
it('orders all account writes and reads through one chain (F12/F14)', async () => {
  await loadWorklist(id);
  const gate = deferred<Response>();
  api.mockImplementationOnce(() => gate.promise);
  const first = add(2);
  const second = add(3);
  const read = loadWorklist(id, true);
  const refresh = syncWorklists();
  await settle();
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  rows.set(id, { name: 'A', hashes: [1, 2] });
  revision++;
  gate.resolve(reply());
  await Promise.all([first, second, read, refresh]);
  expect(hashes()).toEqual([1, 2, 3]);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
});
it('serializes an old row read before a save so it cannot overwrite the acknowledgement (F12)', async () => {
  await loadWorklist(id);
  const gate = deferred<Response>();
  api.mockImplementationOnce(() => gate.promise);
  const read = loadWorklist(id, true);
  const saving = add(2);
  await settle();
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  gate.resolve(reply());
  await Promise.all([read, saving]);
  expect(hashes()).toEqual([1, 2]);
});
it('serializes an old index before an authoritative deletion read (F15)', async () => {
  await loadWorklist(id);
  const stale = await server('/worklists');
  const gate = deferred<Response>();
  api.mockImplementationOnce(() => gate.promise);
  const refresh = syncWorklists();
  const read = loadWorklist(id, true);
  rows.delete(id);
  gate.resolve(stale);
  await refresh;
  await expect(read).rejects.toThrow('deleted');
  expect(useSavedWorklists.getState().lists).toEqual([]);
});
it('rebases exactly once on conflict, applying only this operation (F4)', async () => {
  await loadWorklist(id);
  rows.set(id, { name: 'Remote', hashes: [1, 3] });
  revision++;
  await add(2);
  expect(hashes()).toEqual([1, 3, 2]);
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Remote');
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
});
it.each(['offline', '500', '409', 'deleted'])(
  'keeps the saved display on %s failure, refresh never replays, and Retry sends only that op',
  async (failure) => {
    await loadWorklist(id);
    api.mockImplementation(async (path, init) => {
      if (init?.method !== 'PUT') return server(path, init);
      if (failure === 'offline') throw new Error('offline');
      if (failure === 'deleted') return Response.json({ worklist: null, revision: null });
      return new Response('{}', { status: Number(failure) });
    });
    expect(await add(2)).toBe(false);
    expect(hashes()).toEqual([1]);
    expect(useSavedWorklists.getState().saving).toEqual([]);
    const failed = useSavedWorklists.getState().failed[0]!;
    expect(failed.op).toEqual({ type: 'add', hashes: [2] });
    const puts = api.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
    expect(puts).toBe(failure === '409' ? 2 : 1);
    api.mockImplementation(server);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await syncWorklists();
    expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(puts);
    expect(await retryWorklist(failed)).toBe(true);
    expect(hashes()).toEqual([1, 2]);
    expect(await retryWorklist(failed)).toBe(false);
  },
);
it('keeps a failed conflict refetch out of the display (F6)', async () => {
  await loadWorklist(id);
  rows.delete(id);
  expect(await add(2)).toBe(false);
  expect(hashes()).toEqual([1]);
  expect(useSavedWorklists.getState().failed).toHaveLength(1);
});
it('does not block later operations behind a failed save (F8)', async () => {
  await loadWorklist(id);
  api.mockResolvedValueOnce(new Response('{}', { status: 413 }));
  const failed = add(2);
  const later = add(3);
  expect(await failed).toBe(false);
  expect(await later).toBe(true);
  expect(rows.get(id)!.hashes).toEqual([1, 3]);
  expect(useSavedWorklists.getState().failed).toHaveLength(1);
});
it('creates, renames, removes, moves both ways, and deletes with one operation each', async () => {
  await useSavedWorklists.getState().add(null, 'New', []);
  const created = useSavedWorklists.getState().lists.find((row) => row.id !== id)!;
  expect(created.name).toBe('New');
  await loadWorklist(id);
  await add(2);
  await add(3);
  await useSavedWorklists.getState().change(id, { type: 'rename', name: 'Renamed' });
  await useSavedWorklists.getState().change(id, { type: 'move', hash: 1, index: 2 });
  expect(rows.get(id)!.hashes).toEqual([2, 3, 1]);
  await useSavedWorklists.getState().change(id, { type: 'move', hash: 1, index: 0 });
  expect(rows.get(id)!.hashes).toEqual([1, 2, 3]);
  await useSavedWorklists.getState().change(id, { type: 'remove', hashes: [2] });
  expect(rows.get(id)).toEqual({ name: 'Renamed', hashes: [1, 3] });
  await useSavedWorklists.getState().change(id, { type: 'delete' });
  expect(rows.has(id)).toBe(false);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(8);
});
it.each(['response', 'json'])(
  'aborts requests and drops late %s from A without touching B (F9/F10/F13)',
  async (phase) => {
    await loadWorklist(id);
    const gate = deferred<Response>();
    const body = deferred<unknown>();
    api.mockImplementationOnce(() =>
      phase === 'response'
        ? gate.promise
        : Promise.resolve({ ok: true, status: 200, json: () => body.promise }),
    );
    const old = add(2);
    const cancelled = add(3);
    await settle();
    const signal = api.mock.calls.at(-1)![1].signal as AbortSignal;
    useAuthStore.setState({
      user: { id: 2, login: 'two', role: 'editor' } as never,
      token: sessionToken,
    });
    expect(signal.aborted).toBe(true);
    await settle();
    const newSave = useSavedWorklists.getState().add(null, 'B', []);
    await newSave;
    await settle();
    const before = JSON.stringify(useSavedWorklists.getState());
    if (phase === 'response') gate.resolve(reply());
    else body.resolve({ worklist: { id, name: 'Old', hashes: [1, 2] }, revision: rev() });
    await Promise.all([old, cancelled]);
    await settle();
    expect(useSavedWorklists.getState().scope).toBe('2');
    expect(JSON.stringify(useSavedWorklists.getState())).toBe(before);
    expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  },
);
it('clears failed operations on sign-out, never persists or recovers them (F5/F7/F11)', async () => {
  await loadWorklist(id);
  api.mockRejectedValueOnce(new Error('offline'));
  await add(2);
  expect(localStorage.getItem('clarity-worklists:v3:1')).not.toContain('"hash":2');
  expect(Object.keys(localStorage).some((key) => key.includes('pending'))).toBe(false);
  useAuthStore.setState({ user: null });
  expect(useSavedWorklists.getState().lists).toEqual([]);
  expect(useSavedWorklists.getState().failed).toEqual([]);
  useAuthStore.setState({
    user: { id: 1, login: 'one', role: 'editor' } as never,
    token: sessionToken,
  });
  await settle();
  expect(rows.get(id)!.hashes).toEqual([1]);
});
it('reads index on focus and visibility, invalidates changed rows, and never sends storage signals (F4)', async () => {
  await loadWorklist(id);
  rows.set(id, { name: 'Remote', hashes: [3] });
  revision++;
  window.dispatchEvent(new Event('focus'));
  await settle();
  expect(useSavedWorklists.getState().lists[0]!.name).toBe('Remote');
  expect(useSavedWorklists.getState().loaded).toEqual([]);
  await loadWorklist(id);
  expect(hashes()).toEqual([3]);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(api.mock.calls.at(-1)![0]).toBe('/worklists');
  const count = api.mock.calls.length;
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'clarity-worklists:v3:1:invalidate',
      newValue: JSON.stringify({ id }),
    }),
  );
  await settle();
  expect(api.mock.calls).toHaveLength(count);
  expect(api.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
it('treats cached content as display only after reconnect', async () => {
  await loadWorklist(id);
  disconnect();
  disconnect = connectWorklists();
  await settle();
  expect(useSavedWorklists.getState().loaded).toEqual([]);
  rows.set(id, { name: 'A', hashes: [3] });
  await loadWorklist(id);
  expect(hashes()).toEqual([3]);
});
it('rejects actions during incomplete authentication and drops old reads after loading starts', async () => {
  const gate = deferred<Response>();
  api.mockImplementationOnce(() => gate.promise);
  const reading = loadWorklist(id, true);
  await settle();
  useAuthStore.setState({ loading: true });
  expect(() => useSavedWorklists.getState().add(null, 'No', [])).toThrow('Sign in');
  gate.resolve(reply());
  await expect(reading).rejects.toThrow('account changed');
  expect(useSavedWorklists.getState().loaded).toEqual([]);
});
it('loads the account once its auth check finishes, without a reset on later re-checks', async () => {
  disconnect();
  useAuthStore.setState({ loading: true });
  disconnect = connectWorklists();
  api.mockClear();
  await settle();
  expect(api).not.toHaveBeenCalled();
  useAuthStore.setState({ loading: false });
  await settle();
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/worklists']);
  useAuthStore.setState({ loading: true });
  useAuthStore.setState({ loading: false });
  await settle();
  expect(api).toHaveBeenCalledTimes(1);
  expect(useSavedWorklists.getState().lists.map((row) => row.name)).toEqual(['A']);
});
it.each(['unsent', 'committed'] as const)(
  'keeps a %s save retryable when a same-account auth re-check interrupts it (sec F1)',
  async (variant) => {
    await loadWorklist(id);
    const gate = deferred<Response>();
    api.mockImplementationOnce(async (path: string, init?: RequestInit) => {
      if (variant === 'committed') await server(path, init);
      return gate.promise;
    });
    const saving = add(2);
    await settle();
    useAuthStore.setState({ loading: true });
    gate.resolve(new Response('{}', { status: 503 }));
    expect(await saving).toBe(false);
    await settle();
    const state = useSavedWorklists.getState();
    expect(state.saving).toEqual([]);
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0]!.op).toEqual({ type: 'add', hashes: [2] });
    useAuthStore.setState({ loading: false });
    await settle();
    expect(await retryWorklist(useSavedWorklists.getState().failed[0]!)).toBe(true);
    await settle();
    expect(rows.get(id)!.hashes).toEqual([1, 2]);
    expect(useSavedWorklists.getState().failed).toEqual([]);
  },
);
// Removed F4 automatic storage-event convergence: tabs now refresh on focus/visibility.
// Removed F5 offline-account reconnect replay: failed ops are never replayed after reconnect.
// Removed F6 copy/discard recovery: failed ops leave the saved state intact, with explicit Retry.
// Removed F7 discovery/copy of other sessions: durable pending content no longer exists.
// Removed F8 permanent-head discard: failed ops no longer block later saves.
// Removed F9 receiving-flight drain: the storage-event receiving flight was removed.
// Removed F10 optimistic Rebuild overlay: Rebuild reads through the serial server chain.
// Removed unsaved-create Rebuild: new lists enter the cache only after server success.
// Removed F11 cloned-document durable recovery: no pending content is persisted.

it('preserves consecutive rename intents even when the last action restores the saved name', async () => {
  await loadWorklist(id);
  const first = useSavedWorklists.getState().change(id, { type: 'rename', name: 'Other' });
  const second = useSavedWorklists.getState().change(id, { type: 'rename', name: 'A' });
  await Promise.all([first, second]);
  expect(rows.get(id)!.name).toBe('A');
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
});
