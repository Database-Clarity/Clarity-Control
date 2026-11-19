// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth';
import { useDataStore, type EditorData } from './data';
import { useGlobalIdentities } from './globalIdentities';
import { loadGlobalIdentities, globalsSession } from './globalEntries';
import { clearSavedOverlay } from './savedOverlay';
import { globalFixtureSnapshot } from '../../test/globals-entries-fixture';
import type { GlobalEntry } from '../services/globals';

const transport = vi.hoisted(() => ({ entry: vi.fn(), reviews: vi.fn(), mutate: vi.fn() }));
vi.mock('../services/globalsHttp', () => ({ createGlobalsHttpTransport: () => transport }));
const user = { id: 1, login: 'alice', role: 'editor' as const };
const head = 'a'.repeat(40);
const sync = { status: 'current' as const, causeIds: [], lastFailure: null, causeEntries: {} };
const [damage, title] = globalFixtureSnapshot.entries;

/** The editor data the tooltips load, carrying the publisher's globals catalogue. */
function editorData(
  entries: GlobalEntry[] | null,
  sourceCommit = head,
  generatedAt = new Date().toISOString(),
) {
  return {
    bundle: {
      sourceCommit,
      generatedAt,
      tooltips: {},
      permissions: { users: {} },
      pushed: {},
      ...(entries ? { globals: { entries, sync } } : { globals: null }),
    },
  } as unknown as EditorData;
}
const load = vi.fn();
function ready(entries: GlobalEntry[] | null, sourceCommit?: string, generatedAt?: string) {
  useDataStore.setState({ status: 'ready', data: editorData(entries, sourceCommit, generatedAt) });
}
function loading() {
  useDataStore.setState({ status: 'loading', data: null, error: null });
}
beforeEach(() => {
  useDataStore.setState({ status: 'idle', data: null, error: null, load });
});
afterEach(() => {
  useAuthStore.setState({ user: null, token: null, loading: false });
  useGlobalIdentities.setState({ identities: {}, status: 'idle', error: '' });
  load.mockReset();
  for (const mock of Object.values(transport)) mock.mockReset();
  clearSavedOverlay();
});
const ids = () => Object.keys(useGlobalIdentities.getState().identities);

it('does not read the catalogue without an editing role', async () => {
  useAuthStore.setState({ user: null, token: null, loading: false });
  await loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, role: null }, token: 'reader' });
  await loadGlobalIdentities();
  expect(load).not.toHaveBeenCalled();
  expect(useGlobalIdentities.getState().status).toBe('idle');
});

it.each(['maintainer', 'editor', 'translator', 'trial'] as const)(
  'lists the whole bundle catalogue for %s with no Worker read',
  async (role) => {
    useAuthStore.setState({ user: { ...user, role }, token: `bundle-${role}`, loading: false });
    ready([damage, title]);
    await loadGlobalIdentities();
    expect(useGlobalIdentities.getState().status).toBe('ready');
    expect(ids()).toEqual([damage.id, title.id]);
    expect(transport.entry).not.toHaveBeenCalled();
    expect(transport.reviews).not.toHaveBeenCalled();
  },
);

it('starts the editor data load on a cold tab and lists globals once it lands', async () => {
  useAuthStore.setState({ user, token: 'cold', loading: false });
  load.mockImplementation(() => loading());
  const pending = loadGlobalIdentities();
  expect(load).toHaveBeenCalledTimes(1);
  expect(useGlobalIdentities.getState().status).toBe('loading');
  ready([damage]);
  await pending;
  expect(useGlobalIdentities.getState().status).toBe('ready');
  expect(ids()).toEqual([damage.id]);
});

it('clears saved bodies on sign-out and rejects a catalogue reply from that session', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  loading();
  const old = loadGlobalIdentities();
  useGlobalIdentities.setState({
    identities: { g_damage0001: { kind: 'variables', name: 'Damage', definitions: { en: '15%' } } },
  });
  useAuthStore.setState({ user: null, token: null });
  expect(useGlobalIdentities.getState()).toMatchObject({ identities: {}, status: 'idle' });
  ready([damage, title]);
  await old;
  expect(useGlobalIdentities.getState()).toMatchObject({ identities: {}, status: 'idle' });
});

it('finishes the existing catalogue read when account languages refresh with the same token and role', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  loading();
  const pending = loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, languages: ['fr'] } });
  expect(loadGlobalIdentities()).toBe(pending);
  ready([damage, title]);
  await pending;
  expect(useGlobalIdentities.getState().status).toBe('ready');
});

it('clears a pending catalogue when a role is removed without changing the token', async () => {
  useAuthStore.setState({ user, token: 'alice', loading: false });
  loading();
  const pending = loadGlobalIdentities();
  useAuthStore.setState({ user: { ...user, role: null } });
  ready([damage, title]);
  await pending;
  await loadGlobalIdentities();
  expect(useGlobalIdentities.getState()).toMatchObject({ status: 'idle', identities: {} });
});

it('does not reuse a session cache across sign-out and sign-in with the same token', async () => {
  useAuthStore.setState({ user, token: 'returning', loading: false });
  ready([damage]);
  const first = globalsSession().service;
  await loadGlobalIdentities();
  useAuthStore.setState({ user: null, token: null });
  useAuthStore.setState({ user, token: 'returning' });
  expect(globalsSession().service).not.toBe(first);
  ready([title]);
  await loadGlobalIdentities();
  expect(ids()).toEqual([title.id]);
});

it('says the catalogue is unavailable when the bundle has none, keeps the last list, and recovers on Retry', async () => {
  useAuthStore.setState({ user, token: 'unavailable', loading: false });
  ready([damage, title]);
  await loadGlobalIdentities();
  const previous = useGlobalIdentities.getState().identities;
  ready(null);
  expect((await globalsSession().service.read()).kind).toBe('retry');
  expect(useGlobalIdentities.getState()).toMatchObject({
    status: 'failed',
    error: 'Sync pending: global metadata is incomplete',
    identities: previous,
  });
  // Retry: the same bundle is never reread; the data loader's background refresh fetches anew.
  load.mockImplementation(async () => ready([title]));
  await loadGlobalIdentities(true);
  expect(load).toHaveBeenCalledWith({ background: true });
  expect(useGlobalIdentities.getState().status).toBe('ready');
  expect(ids()).toEqual([title.id]);
});

it('keeps saying unavailable when the reloaded bundle still has no catalogue', async () => {
  useAuthStore.setState({ user, token: 'still-unavailable', loading: false });
  ready(null);
  await loadGlobalIdentities();
  expect(useGlobalIdentities.getState().status).toBe('failed');
  load.mockImplementation(async () => ready(null));
  await loadGlobalIdentities(true);
  await loadGlobalIdentities(true);
  expect(load).toHaveBeenCalledTimes(2);
  expect(useGlobalIdentities.getState()).toMatchObject({
    status: 'failed',
    error: 'Sync pending: global metadata is incomplete',
  });
});

it('turns a failed editor data load into an explicit failed state', async () => {
  useAuthStore.setState({ user, token: 'data-failure', loading: false });
  load.mockImplementation(() => loading());
  const pending = loadGlobalIdentities();
  useDataStore.setState({ status: 'error', error: 'Bundle request failed' });
  await pending;
  expect(useGlobalIdentities.getState()).toMatchObject({
    status: 'failed',
    error: 'Bundle request failed',
  });
});

it('shows a saved entry until the bundle is built from the saved head, also in a new session', async () => {
  useAuthStore.setState({ user, token: 'saver', loading: false });
  ready([damage, title]);
  const savedHead = 'c'.repeat(40);
  const saved = {
    ...damage,
    revision: 'r2',
    definitions: { ...damage.definitions, en: { ...damage.definitions.en!, body: '25%' } },
  };
  transport.mutate.mockResolvedValueOnce({
    kind: 'ok',
    value: {
      ...sync,
      status: 'sync-pending',
      causeIds: ['c1'],
      version: 1,
      head: savedHead,
      entry: saved,
    },
  });
  const service = globalsSession().service;
  await service.read();
  const result = await service.mutate({
    expectedHead: head,
    mutation: {
      operation: 'edit',
      id: damage.id,
      revision: damage.revision,
      lang: 'en',
      body: '25%',
    },
  });
  expect(result.kind).toBe('ok');
  const body = () => useGlobalIdentities.getState().identities[damage.id]?.definitions.en;
  // A new session (sign-out and in) reads the older bundle, with the saved entry on top.
  useAuthStore.setState({ user: null, token: null });
  useAuthStore.setState({ user, token: 'saver-2' });
  await loadGlobalIdentities();
  expect(body()).toBe('25%');
  // The bundle rebuilt from the saved head: its own copy shows (here, a later edit by someone).
  const later = {
    ...saved,
    revision: 'r3',
    definitions: { ...saved.definitions, en: { ...saved.definitions.en!, body: '30%' } },
  };
  ready([later, title], savedHead);
  await loadGlobalIdentities(true);
  expect(body()).toBe('30%');
});
