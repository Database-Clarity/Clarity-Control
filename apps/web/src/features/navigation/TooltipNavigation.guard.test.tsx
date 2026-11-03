// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from '../tooltip/TooltipPage';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { reviewKey, usePreviewReviewStore } from '../../stores/previewReview';
import { useSettingsStore } from '../../stores/settings';

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
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));
vi.mock('../editor', () => ({ ClarityEditor: () => null }));
vi.mock('../preview', () => ({ PreviewColumn: () => null, TooltipPreview: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));
vi.mock('../tooltip/VariantWorkspace', () => ({
  VariantWorkspace: ({ editor }: { editor: ReactNode }) => editor,
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
const item = (hash: number) => ({
  hash,
  name: `Sample ${hash}`,
  icon: '',
  categoryId: 'samples',
  inGameDescription: '',
});
const data = {
  categories: [{ id: 'samples', label: 'Samples', group: 'Test', order: 1 }],
  items: { 100: item(100), 101: item(101), 102: item(102) },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-01T00:00:00Z',
    tooltips: {
      1: tooltip(1),
      2: tooltip(2),
      3: tooltip(3),
      100: tooltip(100),
      101: tooltip(101),
      102: tooltip(102),
    },
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
let host: HTMLDivElement;
let root: Root | undefined;
let router: ReturnType<typeof createMemoryRouter>;

const route = () => router.state.location.pathname;
const dialog = () => host.querySelector('dialog[open]');
const tooltipField = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;

async function mount(path = '/t/100') {
  router = createMemoryRouter(
    [{ element: <Layout />, children: [{ path: '/t/:hash', element: <TooltipPage /> }] }],
    { initialEntries: [path] },
  );
  root = createRoot(host);
  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
}
async function shiftWheel() {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    deltaY: 100,
  });
  await act(async () => host.dispatchEvent(event));
  return event;
}
async function press(name: string) {
  await act(async () => {
    tooltipField().dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}
async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement).click());
}
const named = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.replace(/(Enter|Esc)$/, '') === label,
  );

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const values = new Map<string, string>([
    [reviewKey('anonymous'), JSON.stringify({ 100: { canonical: 100, dirty: 1, reviewed: 0 } })],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
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
  // The preview column is collapsed: the page registers itself as the preview host, and nothing
  // is shown until the column is expanded.
  useSettingsStore.getState().setPane('editor:left', { width: 336, collapsed: true });
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
  useSettingsStore.getState().setPane('editor:left', null);
  host.remove();
  delete (window as { matchMedia?: unknown }).matchMedia;
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('stepping and the preview leave guard', () => {
  it('consumes a blocked Shift+wheel gesture: the selection, route and history stay put', async () => {
    await mount();
    const history = router.state.historyAction;
    const event = await shiftWheel();
    expect(event.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/100');
    expect(tooltipField().value).toBe('Sample 100');
    expect(dialog()?.textContent).toContain('Your changes to Sample 100');
    expect(router.state.historyAction).toBe(history);
    // With the prompt open, more wheel input is ignored rather than queued.
    const again = await shiftWheel();
    expect(again.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/100');
  });

  it('blocks arrow-key stepping before anything moves', async () => {
    await mount();
    await press('ArrowDown');
    expect(route()).toBe('/t/100');
    expect(dialog()).not.toBeNull();
    await click(named('Stay'));
    expect(dialog()).toBeNull();
    await press('ArrowDown');
    expect(route()).toBe('/t/100');
    expect(dialog()).not.toBeNull();
  });

  it('blocks choosing another tooltip from the finder', async () => {
    await mount();
    await click(tooltipField());
    const option = [...host.ownerDocument.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('Sample 102'),
    );
    await click(option);
    expect(route()).toBe('/t/100');
    expect(dialog()).not.toBeNull();
    // The field shows the current item again; nothing was changed or replayed.
    expect(tooltipField().value).toBe('Sample 100');
  });

  it('steps again once the preview has rendered the change, and a later edit re-arms it', async () => {
    await mount();
    await shiftWheel();
    await click(named('Stay'));
    await act(async () => usePreviewReviewStore.getState().acknowledge(100, 1));
    const event = await shiftWheel();
    expect(event.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/101');
    expect(tooltipField().value).toBe('Sample 101');
    expect(dialog()).toBeNull();
    // A hidden edit on the new item blocks the next step from it.
    await act(async () =>
      usePreviewReviewStore.setState({
        entries: { 101: { canonical: 101, dirty: 1, reviewed: 0 } },
      }),
    );
    await shiftWheel();
    expect(route()).toBe('/t/101');
    expect(dialog()).not.toBeNull();
  });

  it('finishes history as origin then destination when stepping onto an unreviewed item, with no prompt', async () => {
    usePreviewReviewStore.setState({ entries: {} });
    const values = new Map([
      [reviewKey('anonymous'), JSON.stringify({ 101: { canonical: 101, dirty: 1, reviewed: 0 } })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
    await mount('/t/100');
    await shiftWheel();
    expect(route()).toBe('/t/101');
    // One idle second later the restore (replace origin, push destination) must not be refused
    // just because the item stepped onto has a change waiting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1150));
    });
    expect(dialog()).toBeNull();
    expect(route()).toBe('/t/101');
    // Leaving the item that was stepped onto is still guarded: Back asks first, then works.
    await act(async () => router.navigate(-1));
    expect(route()).toBe('/t/101');
    expect(dialog()).not.toBeNull();
    await click(named('Stay'));
    await act(async () => usePreviewReviewStore.getState().acknowledge(101, 1));
    await act(async () => router.navigate(-1));
    expect(route()).toBe('/t/100');
    expect(dialog()).toBeNull();
  });

  it('does not touch a gesture on an item with nothing unreviewed', async () => {
    await mount('/t/101');
    const event = await shiftWheel();
    expect(event.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/102');
    expect(dialog()).toBeNull();
  });
});
