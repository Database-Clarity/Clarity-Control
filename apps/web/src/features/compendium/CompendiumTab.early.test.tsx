// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import approved from './approved-guidance.v1.json';
import { displayMatches } from './displayMatches';
import { noteEditorEntry } from './editorEntry';
import type { PriorityReview } from './matchingSessionPlanning';
import { useCompendiumQueueStore } from './queueStore';
import { emptyProgress } from './reviewProgress';
import { useAdvanceSetting } from './advanceSetting';
import { useCompendiumStore } from './store';
import { CompendiumQueue } from './CompendiumQueue';
import { CompendiumTab } from './CompendiumTab';

type Display = ReturnType<typeof displayMatches>;
const state = vi.hoisted(() => ({
  prepared: undefined as unknown,
  review: undefined as unknown,
  matching: true,
  proposals: new Map(),
  reviewHash: undefined as number | undefined,
}));
vi.mock('./useDisplayMatches', () => ({
  useDisplayMatches: (...args: unknown[]) => {
    state.reviewHash = args[5] as number | undefined;
    const review = state.review as PriorityReview | undefined;
    return {
      prepared: state.prepared,
      reviewPrepared: state.prepared,
      review: review?.hash === state.reviewHash ? review : undefined,
      loading: !state.prepared,
    };
  },
}));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: state.proposals, loading: state.matching, error: undefined }),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.invalid',
}));

let host: HTMLDivElement;
let root: Root;
let fixture: ReturnType<typeof guidedFixture>;
let full: Display;

function Location() {
  const location = useLocation();
  return createElement('output', { 'data-route': '' }, location.pathname + location.search);
}
const route = () =>
  new URL(host.querySelector('[data-route]')!.textContent!, 'https://synthetic.invalid');
const title = () =>
  host.querySelector('[aria-label="Entry to review"] [role="heading"]')?.textContent ?? '';
const bar = () => host.querySelector('[aria-label="Review actions"]')!;
const barButton = (text: string) =>
  [...bar().querySelectorAll('button')].find((button) => button.textContent?.startsWith(text))!;
const counts = () => host.querySelector('article > header > p')?.textContent ?? '';
const press = async (key: string) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
let path = '';
const render = (to = path) =>
  act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [(path = to)] },
        createElement(
          Fragment,
          null,
          createElement(Location),
          createElement(CompendiumQueue),
          createElement(CompendiumTab),
        ),
      ),
    ),
  );
/** What the worker's priority reply carries for one hash (proposals.worker.test proves equality). */
function reviewOf(hash: number): PriorityReview {
  const match = full.matches.get(hash);
  return {
    hash,
    fingerprint: full.fingerprint,
    baseline: '',
    entry: full.categories.flatMap((c) => c.entries).find((e) => e.hash === hash),
    proposal: fixture.proposals.get(hash),
    decision: full.decisions.find((d) => d.hash === hash),
    matches: new Map(match ? [[hash, match]] : []),
  };
}
// The router keeps its location across renders; only the hook's results change.
const modelArrives = () => {
  state.prepared = full;
  state.matching = false;
  return render();
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A worker exists: the tab waits for the worker's model instead of matching on this thread.
  vi.stubGlobal('Worker', class {});
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
    clear: () => cache.clear(),
    key: (index: number) => [...cache.keys()][index] ?? null,
    get length() {
      return cache.size;
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new Error('Blocked network'))),
  );
  fixture = guidedFixture();
  full = displayMatches(
    fixture.editor,
    fixture.source,
    {},
    emptyProgress(),
    undefined,
    approved.scope,
    fixture.proposals,
  );
  Object.assign(state, {
    prepared: undefined,
    review: undefined,
    matching: true,
    proposals: fixture.proposals,
    reviewHash: undefined,
  });
  useDataStore.setState({
    data: fixture.editor,
    status: 'ready',
    error: null,
    load: async () => {},
  });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    pending: 0,
    error: null,
    hydrate: async () => {},
    activate: async () => {},
  });
  useAuthStore.setState({ user: { id: 1, login: 'ed', role: 'editor' }, loading: false });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({
    data: fixture.source,
    loading: false,
    error: null,
    load: async () => {},
  });
  useAdvanceSetting.setState({ ms: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await useDraftStore.getState().flush();
  host.remove();
  useCompendiumQueueStore.setState({ rows: null, selected: undefined, toggled: new Set() });
  vi.unstubAllGlobals();
});

it("shows the route's entry before the model, with every action waiting for it", async () => {
  state.review = reviewOf(102);
  await render('/compendium?hash=102');
  expect(state.reviewHash).toBe(102);
  expect(title()).toContain('Sample 102');
  // Counts and the queue list are placeholders, never zeros.
  expect(counts()).not.toMatch(/\d/);
  expect(host.querySelector('[role="tree"]')).toBeNull();
  for (const label of ['Confirm', 'Pick row', 'Not needed', 'Skip'])
    expect(barButton(label).hasAttribute('disabled')).toBe(true);
  for (const step of ['Previous entry', 'Next entry'])
    expect(host.querySelector(`[aria-label="${step}"]`)?.hasAttribute('disabled')).toBe(true);
  await press('a');
  await press('Enter');
  await press('s');
  await press('p');
  await press('ArrowDown');
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(host.querySelector('[aria-label="Pick a row"]')).toBeNull();
  expect(route().searchParams.get('hash')).toBe('102');
  await modelArrives();
  expect(title()).toContain('Sample 102');
  expect(counts()).toContain('6 to review');
  expect(barButton('Confirm').hasAttribute('disabled')).toBe(false);
  expect(host.querySelector('[aria-label="Next entry"]')?.hasAttribute('disabled')).toBe(false);
});

it("starts a hashless open on the editor's entry when it needs review, and keeps it", async () => {
  noteEditorEntry(103);
  state.review = reviewOf(103);
  await render('/compendium');
  expect(state.reviewHash).toBe(103);
  expect(title()).toContain('Sample 103');
  // The URL takes it after the first paint (a history write is slow).
  expect(route().searchParams.get('hash')).toBeNull();
  await act(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 1))));
  expect(route().searchParams.get('hash')).toBe('103');
  expect(title()).toContain('Sample 103');
  await modelArrives();
  expect(title()).toContain('Sample 103');
  expect(useCompendiumQueueStore.getState().selected).toBe(103);
  // Later hashless URLs (a filter link) start on the queue's first row again.
  await act(async () =>
    host
      .querySelector<HTMLAnchorElement>('header p a')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })),
  );
  expect(route().searchParams.get('hash')).toBeNull();
  expect(title()).toContain('Sample 100');
});

it('waits for the model when the editor entry is not in review, then opens the first row', async () => {
  noteEditorEntry(999);
  state.review = { ...reviewOf(100), hash: 999, entry: undefined, decision: undefined };
  await render('/compendium');
  expect(title()).toBe('');
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await modelArrives();
  expect(title()).toContain('Sample 100');
  expect(route().searchParams.get('hash')).toBeNull();
});
