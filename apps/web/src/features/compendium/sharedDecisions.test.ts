// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiRequest: api,
  apiUrl: 'https://api.invalid',
}));
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useMarksStore } from '../marks/store';
import { useSharedDecisions, useSharedSaves, type SharedDecisions } from './sharedDecisions';

const revision = 'a'.repeat(40);
const at = '2026-11-23T10:00:00Z';
const reply = (compendium?: object) => ({
  types: [],
  entries: {},
  ...(compendium ? { compendium } : {}),
});
const changes = () =>
  api.mock.calls.flatMap(([, init]) =>
    init?.method === 'PUT' ? [JSON.parse(init.body as string).change] : [],
  );
/** Accepts the marks directly: today's reader does not know the section yet. */
const accept = (compendium: object) =>
  useMarksStore.setState({ marks: reply(compendium) as never, revision, writable: true });
// Retries wait 400 ms each.
const settled = () =>
  vi.waitFor(
    () => {
      const { pending, error } = useSharedSaves.getState();
      if (pending.size && !error) throw new Error('still saving');
    },
    { timeout: 10_000 },
  );

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.mockReset();
  api.mockImplementation(async () => Response.json({ marks: reply(), revision }));
  useAuthStore.setState({ user: { id: 1, login: 'm', role: 'maintainer' }, token: 't' });
  useSharedSaves.setState({ pending: new Map(), error: null });
  useDataStore.setState({ data: { aliases: {} } as never });
  useMarksStore.setState({ marks: reply() as never, revision, writable: true, saving: false });
});
afterEach(() => {
  useDataStore.setState({ data: null });
});

function shown() {
  let value!: SharedDecisions;
  const root = createRoot(document.createElement('div'));
  act(() =>
    root.render(
      createElement(() => {
        value = useSharedDecisions();
        return null;
      }),
    ),
  );
  act(() => root.unmount());
  return value;
}

it('shows decisions at once and writes those made meanwhile in one later request', async () => {
  let release!: () => void;
  api.mockImplementationOnce(async () => {
    await new Promise<void>((done) => (release = done));
    return Response.json({ marks: reply(), revision });
  });
  const { set } = useSharedSaves.getState();
  set([1], 'not-needed');
  expect(shown().get(1)).toEqual({ kind: 'not-needed' });
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  set([2], 'no-match');
  set([3], 'no-match');
  set([1], null);
  // Until the server has them, leaving the page asks first.
  const leave = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(leave()).toBe(true);
  release();
  await settled();
  expect(leave()).toBe(false);
  expect(changes()).toEqual([
    { action: 'compendium-set', kind: 'not-needed', hashes: [1] },
    { action: 'compendium-clear', hashes: [1] },
    { action: 'compendium-set', kind: 'no-match', hashes: [2, 3] },
  ]);
  expect(shown().size).toBe(0);
});

it('splits large sets and loses none of them when a batch fails', { timeout: 20_000 }, async () => {
  const hashes = Array.from({ length: 450 }, (_, index) => index + 10);
  let puts = 0;
  api.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && ++puts > 1 && puts < 5)
      return Response.json({ error: 'GitHub is down' }, { status: 502 });
    return Response.json({ marks: reply(), revision });
  });
  useSharedSaves.getState().set(hashes, 'not-needed');
  await settled();
  expect(useSharedSaves.getState().error).toContain('GitHub is down');
  expect(useSharedSaves.getState().pending.size).toBe(250);
  expect(shown().size).toBe(250);
  useSharedSaves.getState().retry();
  await settled();
  expect(useSharedSaves.getState().pending.size).toBe(0);
  const saved = changes().flatMap((change) => change.hashes as number[]);
  expect(new Set(saved)).toEqual(new Set(hashes));
  expect(Math.max(...changes().map((change) => change.hashes.length))).toBe(200);
});

it(
  'reloads the marks and writes again after a lost race; discarding gives the decision up',
  { timeout: 20_000 },
  async () => {
    api.mockImplementationOnce(async () =>
      Response.json({ error: 'Marks changed' }, { status: 409 }),
    );
    useSharedSaves.getState().set([7], 'no-match');
    await settled();
    expect(useSharedSaves.getState().error).toBeNull();
    expect(api.mock.calls.map(([path, init]) => `${init?.method ?? 'GET'} ${path}`)).toEqual([
      'PUT /marks',
      'GET /marks',
      'PUT /marks',
    ]);
    api.mockImplementation(async () => Response.json({ error: 'No' }, { status: 403 }));
    useSharedSaves.getState().set([8], 'no-match');
    await settled();
    expect(useSharedSaves.getState().error).not.toBeNull();
    useSharedSaves.getState().discard();
    expect(shown().has(8)).toBe(false);
  },
);

it('never writes one account’s decisions as another', async () => {
  api.mockImplementationOnce(async () => {
    useAuthStore.setState({ user: { id: 2, login: 'other', role: 'maintainer' } });
    return Response.json({ marks: reply(), revision });
  });
  useSharedSaves.getState().set([1], 'not-needed');
  useSharedSaves.getState().set([2], 'no-match');
  await settled();
  expect(changes()).toHaveLength(1);
  expect(useSharedSaves.getState().pending.size).toBe(0);
});

it('shows a grouped entry’s decision on its main entry, and clearing removes the stored one', async () => {
  useDataStore.setState({ data: { aliases: { 11: { to: 10, kind: 'name' } } } as never });
  accept({ 11: { kind: 'no-match', by: 1, at }, 12: { kind: 'not-needed', by: 1, at } });
  expect([...shown().keys()]).toEqual([10, 12]);
  // The main entry's own decision outranks the grouped one.
  accept({ 11: { kind: 'no-match', by: 1, at }, 10: { kind: 'not-needed', by: 1, at } });
  expect(shown().get(10)!.kind).toBe('not-needed');
  useSharedSaves.getState().set([10], null);
  expect(shown().has(10)).toBe(false);
  await settled();
  expect(changes()).toEqual([{ action: 'compendium-clear', hashes: [10, 11] }]);
});
