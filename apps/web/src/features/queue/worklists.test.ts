// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectWorklists, loadWorklist, syncWorklists, useSavedWorklists } from './worklists';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';
import type { SavedWorklist } from '../../../../../packages/core/src/worklists';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiAuth', () => ({ apiRequest: request }));
const list: SavedWorklist = {
  id: 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97',
  name: 'Weekend',
  items: [{ hash: 1, name: 'One' }],
};
let disconnect: (() => void) | undefined;
const response = (worklist: SavedWorklist | null, revision = 'a'.repeat(32), status = 200) =>
  new Response(
    JSON.stringify({
      worklist: worklist
        ? { id: worklist.id, name: worklist.name, hashes: worklist.items.map((item) => item.hash) }
        : null,
      revision,
    }),
    { status },
  );
const indexResponse = (lists: SavedWorklist[], revision = 'a'.repeat(32)) =>
  new Response(
    JSON.stringify({
      lists: lists.map((list) => ({
        id: list.id,
        name: list.name,
        count: list.items.length,
        updatedAt: 1,
        revision,
      })),
    }),
  );
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  useAuthStore.setState({ user: null, token: null, loading: false });
  useSavedWorklists.setState({
    scope: 'anonymous',
    lists: [],
    pending: false,
    dirty: [],
    removed: {},
    loaded: [],
    index: {},
  });
});
afterEach(() => {
  disconnect?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const login = async () => {
  request.mockResolvedValueOnce(indexResponse([]));
  disconnect = connectWorklists();
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as User });
  await settle();
};
it('debounces additions, saves locally immediately, and deduplicates membership', async () => {
  await login();
  const add = useSavedWorklists.getState().add;
  useSavedWorklists.getState().change([list]);
  add(list.id, '', [
    { hash: 1, name: 'One' },
    { hash: 2, name: 'Two' },
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem('clarity-worklists:v2:1')!).lists[0].items).toHaveLength(
    2,
  );
  request.mockResolvedValueOnce(response(useSavedWorklists.getState().lists[0]!));
  await vi.advanceTimersByTimeAsync(600);
  expect(request).toHaveBeenCalledTimes(2);
  expect(useSavedWorklists.getState().pending).toBe(false);
});
it('allows only one PUT and retains edits made while it is in flight', async () => {
  await login();
  useSavedWorklists.getState().change([list]);
  let resolve!: (value: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const writing = syncWorklists();
  useSavedWorklists.getState().add(list.id, '', [{ hash: 2, name: 'Two' }]);
  await syncWorklists();
  expect(request).toHaveBeenCalledTimes(2);
  resolve(response(list));
  await writing;
  expect(useSavedWorklists.getState().pending).toBe(true);
  expect(useSavedWorklists.getState().lists[0]!.items).toHaveLength(2);
});
it('merges a 409 by id without dropping either device’s additions', async () => {
  await login();
  useSavedWorklists.getState().change([list]);
  const other = { ...list, items: [{ hash: 2, name: 'Two' }] };
  request.mockResolvedValueOnce(response(other, 'b'.repeat(32), 409));
  await syncWorklists();
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([1, 2]);
  expect(useSavedWorklists.getState().pending).toBe(true);
  expect(useSavedWorklists.getState().notice).toContain('Concurrent removals');
});
it('keeps offline edits across disconnect, reconnect, and account switches', async () => {
  await login();
  useSavedWorklists.getState().change([list]);
  request.mockRejectedValueOnce(new Error('offline'));
  await syncWorklists();
  expect(useSavedWorklists.getState().pending).toBe(true);
  useAuthStore.setState({ user: null });
  expect(useSavedWorklists.getState().lists).toEqual([]);
  request.mockResolvedValueOnce(indexResponse([]));
  request.mockResolvedValueOnce(response(list));
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as User });
  await settle();
  expect(useSavedWorklists.getState().lists[0]!.items.map((item) => item.hash)).toEqual([1]);
});
it('ignores a late response for another account', async () => {
  let resolve!: (value: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  disconnect = connectWorklists();
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as User });
  useAuthStore.setState({ user: null });
  resolve(indexResponse([list]));
  await settle();
  expect(useSavedWorklists.getState().scope).toBe('anonymous');
  expect(useSavedWorklists.getState().lists).toEqual([]);
});

it('keeps offline deletions when reconnect finds the same account revision', async () => {
  await login();
  useSavedWorklists.getState().change([list]);
  request.mockResolvedValueOnce(response(list));
  await syncWorklists();
  useSavedWorklists.getState().change([]);
  useAuthStore.setState({ user: null });
  request.mockResolvedValueOnce(indexResponse([list]));
  request.mockResolvedValueOnce(response(null));
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as User });
  await settle();
  expect(useSavedWorklists.getState().lists).toEqual([]);
});

it('loads index metadata without entries and fetches only the opened list', async () => {
  request.mockResolvedValueOnce(indexResponse([list]));
  disconnect = connectWorklists();
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as User });
  await settle();
  expect(useSavedWorklists.getState().lists[0]!.items).toEqual([]);
  expect(useSavedWorklists.getState().index[list.id]!.count).toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce(response(list));
  expect((await loadWorklist(list.id)).items.map((item) => item.hash)).toEqual([1]);
  expect(request.mock.calls[1]![0]).toBe(`/worklists/${list.id}`);
  await loadWorklist(list.id);
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not write an old account’s pending list through a newly replaced session', async () => {
  await login();
  const token = (marker: string) =>
    btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, marker })) + '.fixture';
  const previous = token('previous'),
    next = token('next');
  localStorage.setItem('clarity-editor-session', previous);
  useAuthStore.setState({ token: previous });
  useSavedWorklists.getState().change([list]);
  localStorage.setItem('clarity-editor-session', next);
  await syncWorklists();
  expect(request).toHaveBeenCalledTimes(1);
  expect(useSavedWorklists.getState().pending).toBe(true);
  useAuthStore.setState({ loading: true });
  request.mockResolvedValueOnce(indexResponse([]));
  useAuthStore.setState({
    user: { id: 2, login: 'two', role: 'editor' } as User,
    token: next,
    loading: false,
  });
  await settle();
  expect(useSavedWorklists.getState().scope).toBe('2');
  expect(useSavedWorklists.getState().lists).toEqual([]);
  expect(request.mock.calls.every((call) => call[1]?.method !== 'PUT')).toBe(true);
});
it('does not resurrect a list deleted while its entries are loading', async () => {
  request.mockResolvedValueOnce(indexResponse([list]));
  disconnect = connectWorklists();
  useAuthStore.setState({ user: { id: 1, login: 'one', role: 'editor' } as User });
  await settle();
  let resolve!: (value: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const loading = loadWorklist(list.id);
  useSavedWorklists.getState().change([]);
  resolve(response(list));
  await expect(loading).rejects.toThrow('deleted while loading');
  expect(useSavedWorklists.getState().lists).toEqual([]);
  expect(useSavedWorklists.getState().removed[list.id]).toBe('a'.repeat(32));
});

it('preserves the browser-storage warning when account sync also fails', async () => {
  await login();
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota exceeded');
  });
  useSavedWorklists.getState().change([list]);
  request.mockRejectedValueOnce(new Error('offline'));
  await syncWorklists();
  expect(useSavedWorklists.getState().pending).toBe(true);
  expect(useSavedWorklists.getState().notice).toContain('Keep this tab open');
  expect(useSavedWorklists.getState().notice).not.toContain('local copy is kept');
});
