// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from '../tooltip/TooltipPage';
import { Layout } from '../navigation/Layout';
import { disposeSteppingActivity } from '../navigation/steppingActivity';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { useSettingsStore } from '../../stores/settings';
import { visitOf, type QueueItem } from './model';
import { reviewStamp } from './sources';
import { startQueue } from './start';
import { resetWorkQueues, useWorkQueues } from './store';

vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));
vi.mock('../auth/AuthStatus', () => ({
  useAuthSession: () => undefined,
  IdentityStatus: () => null,
  identitySummary: () => ({ label: 'Account', detail: 'Account', tone: 'out' }),
}));
vi.mock('../compendium/CompendiumBadge', () => ({
  CompendiumBadge: () => null,
  CompendiumWarmup: () => null,
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));
vi.mock('../editor', () => ({ ClarityEditor: () => null }));
vi.mock('../preview', () => ({ PreviewColumn: () => null, TooltipPreview: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));
vi.mock('../tooltip/VariantWorkspace', () => ({
  VariantWorkspace: ({ editor, header }: { editor: ReactNode; header: ReactNode }) => (
    <>
      {header}
      {editor}
    </>
  ),
}));

function tooltip(hash: number): Tooltip {
  return {
    hash,
    text: {
      en: { text: `English ${hash}`, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' },
    },
    associated: [],
  };
}
const hashes = [100, 101, 102, 103, 104, 105];
const data = {
  categories: [{ id: 'samples', label: 'Samples', group: 'Test', order: 1 }],
  items: Object.fromEntries(
    hashes.map((hash) => [
      hash,
      { hash, name: `Sample ${hash}`, icon: '', categoryId: 'samples', inGameDescription: '' },
    ]),
  ),
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-01T00:00:00Z',
    tooltips: Object.fromEntries([1, 2, 3, ...hashes].map((hash) => [hash, tooltip(hash)])),
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

/** A Review queue of 101, 103, and 104; 103 is already saved again (done). */
const item = (hash: number, done = false): QueueItem => ({
  key: `r${hash}`,
  hash,
  name: `Sample ${hash}`,
  detail: done ? 'saved-since' : reviewStamp(data.bundle.tooltips[hash], data.aliases),
});
const items = [item(101), item(103, true), item(104)];

const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
let host: HTMLDivElement;
let root: Root | undefined;
let router: ReturnType<typeof createMemoryRouter>;

const route = () => router.state.location.pathname;
const visitKey = () => visitOf(router.state.location.state)?.key;
const queue = () => Object.values(useWorkQueues.getState().queues)[0]!;
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const position = () => host.querySelector('[data-queue] [role="status"]')?.textContent;

function render(entry: { pathname: string; search?: string; state: unknown }) {
  router = createMemoryRouter(
    [
      { element: <Layout />, children: [{ path: '/t/:hash', element: <TooltipPage /> }] },
      { path: '/review', element: <p>Review</p> },
    ],
    { initialEntries: [entry] },
  );
  root = createRoot(host);
  return act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
}
async function mount(at = items[0]!, source: 'review' | 'translations' = 'review', list = items) {
  const { to, state } = startQueue({
    source,
    scope: 'shown',
    items: list,
    first: at,
    origin: { path: '/review', restore: {} },
  });
  const [pathname, search = ''] = to.split('?');
  await render({ pathname: pathname!, search: search && `?${search}`, state });
}
/** A reload: the same history entry (URL and state) in a new app. */
async function reload() {
  const { pathname, search, state } = router.state.location;
  await act(async () => root?.unmount());
  router.dispose();
  await render({ pathname, search, state });
}
const rest = (ms = 1200) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
async function shiftWheel(deltaY = 100, altKey = false) {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    altKey,
    deltaY,
    deltaMode: 1,
  });
  await act(async () => host.dispatchEvent(event));
  await rest(50);
  return event;
}
async function press(key: string) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
  await rest(50);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    owner: null,
    pending: 0,
    error: null,
    hydrate: async () => {},
    activate: async () => {},
  });
  useAuthStore.setState({ user: null, loading: false });
  usePreviewReviewStore.setState({ scope: null, entries: {}, prompt: null });
  useSettingsStore.getState().setPane('editor:left', { width: 336, collapsed: true });
  useSettingsStore.getState().updateDevice({ worklistStepping: true });
  resetWorkQueues();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  router.dispose();
  disposeSteppingActivity();
  resetWorkQueues();
  useSettingsStore.getState().updateDevice({ worklistStepping: true });
  useSettingsStore.getState().setPane('editor:left', null);
  host.remove();
  delete (window as { matchMedia?: unknown }).matchMedia;
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('worklist stepping', () => {
  it('steps Shift+wheel through the items still to do, keeping the route in the queue', async () => {
    await mount();
    expect(position()).toBe('1 of 2');
    const event = await shiftWheel();
    expect(event.defaultPrevented).toBe(true);
    // 102 is the next entry of the category, 103 is done: the queue's next item still to do is 104.
    expect(route()).toBe('/t/104');
    expect(visitKey()).toBe('r104');
    expect(position()).toBe('2 of 2');
    await rest();
    // Next's skip rule: the open item stepped past is skipped.
    expect(queue().skipped).toEqual(['r101']);
    // One history entry per gesture; Back returns to the origin, still in the queue.
    await act(async () => router.navigate(-1));
    expect(route()).toBe('/t/101');
    expect(visitKey()).toBe('r101');
    expect(position()).toBe('1 of 2');
  });

  it('stops at the first item, and past the last one ends the queue there', async () => {
    await mount();
    const back = await shiftWheel(-100);
    expect(back.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/101');
    await rest();
    await shiftWheel();
    expect(route()).toBe('/t/104');
    // The spin that reached the last item stops there; it does not end the queue.
    await shiftWheel();
    expect(queue().finished).toBe(false);
    await rest();
    // A fresh step forward on the last item is Next's Finish: the queue's end state, no wrap.
    await shiftWheel();
    expect(route()).toBe('/t/104');
    expect(queue().finished).toBe(true);
    expect(position()).toBe('End · 2 skipped');
    await rest();
    // From the end, a step back goes to the previous item still to do and leaves the end state.
    await shiftWheel(-100);
    expect(route()).toBe('/t/101');
    await rest();
    expect(queue().finished).toBe(false);
  });

  it('steps the queue with the finder arrows, Page Down, and Alt+Shift+wheel', async () => {
    await mount();
    await press('ArrowDown');
    expect(route()).toBe('/t/104');
    expect(visitKey()).toBe('r104');
    await rest();
    await press('ArrowUp');
    expect(route()).toBe('/t/101');
    await rest();
    await press('PageDown');
    expect(route()).toBe('/t/104');
    await rest();
    await shiftWheel(-100, true);
    expect(route()).toBe('/t/101');
    expect(visitKey()).toBe('r101');
  });

  it('steps the finder list when the device setting is off (the queue pauses, as before)', async () => {
    await mount();
    await act(async () => useSettingsStore.getState().updateDevice({ worklistStepping: false }));
    await shiftWheel();
    expect(route()).toBe('/t/102');
    expect(visitKey()).toBeUndefined();
    expect(host.querySelector('[data-queue][data-paused]')).not.toBeNull();
    await rest();
    // Flipping it back on mid-queue: Resume returns to the queue, and stepping follows it again.
    await act(async () => useSettingsStore.getState().updateDevice({ worklistStepping: true }));
    await act(async () =>
      host.querySelector<HTMLAnchorElement>('[data-queue][data-paused] a')!.click(),
    );
    expect(route()).toBe('/t/101');
    await shiftWheel();
    expect(route()).toBe('/t/104');
  });

  it('keeps stepping the queue after a reload', async () => {
    await mount();
    await shiftWheel();
    await rest();
    await reload();
    expect(route()).toBe('/t/104');
    expect(position()).toBe('2 of 2');
    await shiftWheel(-100);
    expect(route()).toBe('/t/101');
    expect(visitKey()).toBe('r101');
  });

  it('steps a translator queue in its language', async () => {
    const translation = (hash: number): QueueItem => ({
      key: `${hash}:de`,
      hash,
      lang: 'de',
      name: `Sample ${hash}`,
      detail: { path: `/t/${hash}?lang=de` },
    });
    await mount(translation(101), 'translations', [101, 102, 105].map(translation));
    await shiftWheel();
    expect(route()).toBe('/t/102');
    expect(router.state.location.search).toBe('?lang=de');
    expect(visitKey()).toBe('102:de');
    await rest();
    await press('ArrowDown');
    expect(route()).toBe('/t/105');
    expect(visitKey()).toBe('105:de');
  });

  it('leaves a paused queue alone: an ordinary visit steps the finder list', async () => {
    await mount();
    await act(async () => router.navigate('/t/102'));
    expect(host.querySelector('[data-queue][data-paused]')).not.toBeNull();
    await shiftWheel();
    expect(route()).toBe('/t/103');
    expect(visitKey()).toBeUndefined();
  });
});
