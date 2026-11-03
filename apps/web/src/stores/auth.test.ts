import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../services/api';
import { editorAccess } from '../features/tooltip/access';

const mocks = vi.hoisted(() => ({ getMe: vi.fn(), clearSession: vi.fn(), apiUrl: 'https://example.invalid' as string | undefined }));
vi.mock('../services/api', () => mocks);

const alice: User = { id: 1, login: 'alice', role: 'editor' };
const bob: User = { id: 2, login: 'bob', role: 'editor' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function store() {
  return (await import('./auth')).useAuthStore;
}
function state(s: Awaited<ReturnType<typeof store>>) {
  const { user, loading, error } = s.getState();
  return { user, loading, error };
}

beforeEach(() => {
  vi.resetModules(); // Reset the store and its module-scoped requestId for every test.
  mocks.getMe.mockReset();
  mocks.clearSession.mockReset();
  mocks.apiUrl = 'https://example.invalid';
});

describe('auth store asynchronous invalidation', () => {
  it.each(['success', 'rejection'] as const)('keeps the newer success after an older %s', async (outcome) => {
    const older = deferred<User | null>();
    const newer = deferred<User | null>();
    mocks.getMe.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const s = await store();
    const first = s.getState().load();
    const second = s.getState().load();
    newer.resolve(bob);
    await second;
    if (outcome === 'success') older.resolve(alice); else older.reject(new Error('old failure'));
    await first;
    expect(state(s)).toEqual({ user: bob, loading: false, error: null });
  });

  it.each(['success', 'rejection'] as const)('invalidates pending %s after logout and clears storage', async (outcome) => {
    let token: string | null = 'synthetic';
    mocks.clearSession.mockImplementation(() => { token = null; });
    const pending = deferred<User | null>();
    mocks.getMe.mockResolvedValueOnce(alice).mockReturnValueOnce(pending.promise);
    const s = await store();
    await s.getState().load();
    const load = s.getState().load();
    s.getState().logout();
    expect(token).toBeNull();
    if (outcome === 'success') pending.resolve(bob); else pending.reject(new Error('late failure'));
    await load;
    expect(state(s)).toEqual({ user: null, loading: false, error: null });
  });

  it('retains the signed-in user and reports a storage failure', async () => {
    mocks.getMe.mockResolvedValue(alice);
    mocks.clearSession.mockImplementation(() => { throw new Error('storage denied'); });
    const s = await store();
    await s.getState().load();
    s.getState().logout();
    expect(state(s)).toEqual({ user: alice, loading: false, error: 'Cannot clear session: storage denied' });
  });

  it('treats a null /me result as read-only', async () => {
    mocks.getMe.mockResolvedValue(null); // getMe maps HTTP 401 to null.
    const s = await store();
    await s.getState().load();
    expect(state(s)).toEqual({ user: null, loading: false, error: null });
    expect(editorAccess({ apiConfigured: true, hydrated: true, saving: false, user: s.getState().user, lang: 'en' }).reason).toMatch(/sign in/i);
  });

  it('reports an active failure and clears it on retry', async () => {
    mocks.getMe.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(alice);
    const s = await store();
    await s.getState().load();
    expect(state(s)).toEqual({ user: null, loading: false, error: 'offline' });
    await s.getState().load();
    expect(state(s)).toEqual({ user: alice, loading: false, error: null });
  });

  it('does not fetch when the API is unconfigured', async () => {
    mocks.apiUrl = undefined;
    const s = await store();
    await s.getState().load();
    expect(mocks.getMe).not.toHaveBeenCalled();
    expect(state(s)).toEqual({ user: null, loading: false, error: null });
  });
});

describe('auth identity across reloads', () => {
  it('keeps the same user object when a reload returns the same account', async () => {
    mocks.getMe.mockResolvedValueOnce({ ...alice }).mockResolvedValueOnce({ ...alice });
    const s = await store();
    await s.getState().load();
    const first = s.getState().user;
    await s.getState().load();
    expect(s.getState().user).toBe(first);
  });

  it('replaces the user when the role or account really changed', async () => {
    mocks.getMe
      .mockResolvedValueOnce(alice)
      .mockResolvedValueOnce({ ...alice, role: 'trial' })
      .mockResolvedValueOnce(bob);
    const s = await store();
    await s.getState().load();
    await s.getState().load();
    expect(s.getState().user?.role).toBe('trial');
    await s.getState().load();
    expect(s.getState().user?.id).toBe(2);
  });
});
