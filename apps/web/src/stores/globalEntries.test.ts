// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth';
import { useGlobalIdentities } from './globalIdentities';
import { loadGlobalIdentities } from './globalEntries';
import { globalFixtureSnapshot } from '../../test/globals-entries-fixture';

const list = vi.hoisted(() => vi.fn());
vi.mock('../services/globalsHttp', () => ({
  createGlobalsHttpTransport: () => ({ list }),
}));
const user = { id: 1, login: 'alice', role: 'editor' as const };
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
  resolve({ kind: 'ok', value: { entries: globalFixtureSnapshot.entries, nextCursor: null } });
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
    value: { entries: globalFixtureSnapshot.entries, nextCursor: null },
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
  resolve({ kind: 'ok', value: { entries: globalFixtureSnapshot.entries, nextCursor: null } });
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
  resolve({ kind: 'ok', value: { entries: globalFixtureSnapshot.entries, nextCursor: null } });
  await pending;
  await loadGlobalIdentities();
  expect(useGlobalIdentities.getState()).toMatchObject({ status: 'idle', identities: {} });
  expect(list).toHaveBeenCalledTimes(1);
});
