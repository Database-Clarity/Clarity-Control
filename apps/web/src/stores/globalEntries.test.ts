// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth';
import { useGlobalIdentities } from './globalIdentities';
import { loadGlobalIdentities, globalsSession } from './globalEntries';
import { globalFixtureSnapshot } from '../../test/globals-entries-fixture';

const list = vi.hoisted(() => vi.fn());
vi.mock('../services/globalsHttp', () => ({
  createGlobalsHttpTransport: () => ({ list }),
}));
const user = { id: 1, login: 'alice', role: 'editor' as const };
const header = { head: 'a'.repeat(40), status: 'current', causeIds: [], version: 1 };
afterEach(() => {
  useAuthStore.setState({ user: null, token: null, loading: false });
  useGlobalIdentities.setState({ identities: {}, status: 'idle', error: '' });
  list.mockReset();
});

it('does not request the catalogue without an editing role', async () => {
  useAuthStore.setState({ user: null, token: null, loading: false });
  await loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, role: null }, token: 'reader' });
  await loadGlobalIdentities();
  expect(list).not.toHaveBeenCalled();
});

it('clears saved bodies on sign-out and rejects a catalogue reply from that session', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  let resolve!: (value: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const old = loadGlobalIdentities();
  useGlobalIdentities.setState({
    identities: { g_damage0001: { kind: 'variables', name: 'Damage', definitions: { en: '15%' } } },
  });
  useAuthStore.setState({ user: null, token: null });
  expect(useGlobalIdentities.getState()).toMatchObject({ identities: {}, status: 'idle' });
  resolve({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await old;
  expect(useGlobalIdentities.getState()).toMatchObject({ identities: {}, status: 'idle' });
});

it('allows a new account to load while the previous account read is pending', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  let resolve!: (value: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const old = loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, id: 2, login: 'bob' }, token: 'bob' });
  list.mockResolvedValueOnce({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await loadGlobalIdentities();
  expect(useGlobalIdentities.getState().status).toBe('ready');
  resolve({ kind: 'retry', message: 'Old request failed' });
  await old;
  expect(useGlobalIdentities.getState().status).toBe('ready');
  expect(list).toHaveBeenCalledTimes(2);
});

it('finishes the existing catalogue read when account languages refresh with the same token and role', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  let resolve!: (value: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, languages: ['fr'] } });
  expect(loadGlobalIdentities()).toBe(pending);
  resolve({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await pending;
  expect(useGlobalIdentities.getState().status).toBe('ready');
  expect(list).toHaveBeenCalledTimes(1);
});

it('clears a pending catalogue when a role is removed without changing the token', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  let resolve!: (value: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, role: null } });
  resolve({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await pending;
  await loadGlobalIdentities();
  expect(useGlobalIdentities.getState()).toMatchObject({ status: 'idle', identities: {} });
  expect(list).toHaveBeenCalledTimes(1);
});

it.each(['maintainer', 'editor', 'translator', 'trial'] as const)(
  'publishes catalogue pages before the next page resolves for %s, without reviews',
  async (role) => {
    useAuthStore.setState({ user: { ...user, role }, token: `progress-${role}`, loading: false });
    let finish!: (value: unknown) => void;
    const header = { head: 'a'.repeat(40), status: 'current', causeIds: [], version: 1 };
    list
      .mockResolvedValueOnce({
        kind: 'ok',
        value: {
          ...header,
          entries: [globalFixtureSnapshot.entries[0]],
          nextCursor: 'p1',
        },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    const pending = loadGlobalIdentities();
    await vi.waitFor(() => expect(useGlobalIdentities.getState().status).toBe('loading'));
    await vi.waitFor(() =>
      expect(Object.keys(useGlobalIdentities.getState().identities)).toHaveLength(1),
    );
    expect(loadGlobalIdentities()).toBe(pending);
    finish({
      kind: 'ok',
      value: {
        ...header,
        entries: [globalFixtureSnapshot.entries[1]],
        nextCursor: null,
      },
    });
    await pending;
    expect(useGlobalIdentities.getState().status).toBe('ready');
    expect(Object.keys(useGlobalIdentities.getState().identities)).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(2);
  },
);

it('does not reuse a catalogue across sign-out and sign-in with the same token', async () => {
  useAuthStore.setState({ user, token: 'returning', loading: false });
  let finish!: (value: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const old = loadGlobalIdentities();
  useAuthStore.setState({ user: null, token: null });
  useAuthStore.setState({ user, token: 'returning' });
  list.mockResolvedValueOnce({
    kind: 'ok',
    value: {
      ...header,
      entries: [globalFixtureSnapshot.entries[1]],
      nextCursor: null,
    },
  });
  await loadGlobalIdentities();
  finish({
    kind: 'ok',
    value: {
      ...header,
      entries: [globalFixtureSnapshot.entries[0]],
      nextCursor: null,
    },
  });
  await old;
  expect(Object.keys(useGlobalIdentities.getState().identities)).toEqual([
    globalFixtureSnapshot.entries[1].id,
  ]);
});

it('retains a complete catalogue if a workspace refresh fails, and exposes retry recovery', async () => {
  useAuthStore.setState({ user, token: 'refresh-failure', loading: false });
  list.mockResolvedValueOnce({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await loadGlobalIdentities();
  const previous = useGlobalIdentities.getState().identities;
  let finish!: (value: unknown) => void;
  list
    .mockResolvedValueOnce({
      kind: 'ok',
      value: { ...header, entries: [globalFixtureSnapshot.entries[0]], nextCursor: 'p1' },
    })
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  const refresh = globalsSession().service.read();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  expect(useGlobalIdentities.getState()).toMatchObject({ status: 'ready', identities: previous });
  finish({ kind: 'retry', message: 'Catalogue page failed' });
  await refresh;
  expect(useGlobalIdentities.getState()).toMatchObject({
    status: 'failed',
    error: 'Catalogue page failed',
    identities: previous,
  });
  list.mockResolvedValueOnce({
    kind: 'ok',
    value: { ...header, entries: [globalFixtureSnapshot.entries[1]], nextCursor: null },
  });
  await loadGlobalIdentities(true);
  expect(useGlobalIdentities.getState().status).toBe('ready');
  expect(Object.keys(useGlobalIdentities.getState().identities)).toEqual([
    globalFixtureSnapshot.entries[1].id,
  ]);
});

it('turns a failed progressive first load into an explicit failed state', async () => {
  useAuthStore.setState({ user, token: 'partial-failure', loading: false });
  list
    .mockResolvedValueOnce({
      kind: 'ok',
      value: { ...header, entries: [globalFixtureSnapshot.entries[0]], nextCursor: 'p1' },
    })
    .mockResolvedValueOnce({ kind: 'retry', message: 'Next page failed' });
  await loadGlobalIdentities();
  expect(useGlobalIdentities.getState()).toMatchObject({
    status: 'failed',
    error: 'Next page failed',
  });
  expect(Object.keys(useGlobalIdentities.getState().identities)).toHaveLength(1);
});

it('does not replace a newer successful catalogue with a superseded refresh error', async () => {
  useAuthStore.setState({ user, token: 'refresh-race', loading: false });
  list.mockResolvedValueOnce({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await loadGlobalIdentities();
  let finish!: (value: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const service = globalsSession().service;
  const old = service.read();
  list.mockResolvedValueOnce({
    kind: 'ok',
    value: { ...header, entries: globalFixtureSnapshot.entries, nextCursor: null },
  });
  await service.read();
  finish({ kind: 'retry', message: 'Superseded error' });
  await old;
  expect(useGlobalIdentities.getState()).toMatchObject({ status: 'ready', error: '' });
});
