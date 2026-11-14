// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { Layout } from '../navigation/Layout';
import { ClarityEditor } from '../editor/ClarityEditor';
import { PreviewColumn } from '../preview/PreviewColumn';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { skeletonMinimumMs } from '../../ui/Skeleton';

// SKELETON-HOLDS (Polish2 I U37): each consumer used to unmount its skeleton the moment its
// pending flag ended, so a skeleton already on screen could vanish before its 200 ms minimum.

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
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));

function tooltip(hash: number): Tooltip {
  return {
    hash,
    text: { en: { text: `English ${hash}`, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'x' } },
    associated: [],
  };
}
const data: EditorData = {
  categories: [{ id: 'samples', label: 'Samples', group: 'Test', order: 1 }],
  items: {
    100: { hash: 100, name: 'Sample 100', icon: '', categoryId: 'samples', inGameDescription: '' },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-01T00:00:00Z',
    tooltips: { 1: tooltip(1), 2: tooltip(2), 3: tooltip(3), 100: tooltip(100) },
    permissions: { users: {} },
    pushed: {},
  },
};

const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;

async function frame() {
  const batch = [...frames.values()];
  frames.clear();
  await act(async () => batch.forEach((callback) => callback(0)));
}
/** Two frames reveal the skeleton; the task after the paint frame stamps its minimum. */
async function paint() {
  await frame();
  await frame();
  await frame();
  await act(async () => vi.advanceTimersByTime(0));
}
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    pending: 0,
    error: null,
    hydrate: async () => {},
    activate: async () => {},
  });
  useAuthStore.setState({ user: null, loading: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
});

describe('editor route first load (navigation position and loading workspace panes)', () => {
  async function mount() {
    useDataStore.setState({ data: null, status: 'loading', error: null, load: async () => {} });
    const router = createMemoryRouter(
      [
        {
          element: createElement(Fragment, null, createElement(Layout)),
          children: [{ path: '/t/:hash', element: createElement(TooltipPage) }],
        },
      ],
      { initialEntries: ['/t/100?lang=en'] },
    );
    await act(async () => root.render(createElement(RouterProvider, { router })));
  }
  const navigationSkeleton = () =>
    host.querySelector('section[aria-label="Tooltip navigation"] [aria-hidden="true"]');
  const paneSkeleton = () =>
    host.querySelector('[aria-label="Compendium for 100"] [aria-hidden="true"]');
  const loadingFrame = () => host.querySelector('input[placeholder="Loading tooltips…"]');

  it('keeps painted skeletons for the minimum after the data arrives early', async () => {
    await mount();
    await paint();
    expect(navigationSkeleton()).not.toBeNull();
    expect(paneSkeleton()).not.toBeNull();
    await wait(50);
    await act(async () => useDataStore.setState({ data, status: 'ready' }));
    expect(navigationSkeleton()).not.toBeNull();
    expect(paneSkeleton()).not.toBeNull();
    await wait(skeletonMinimumMs - 51);
    expect(navigationSkeleton()).not.toBeNull();
    expect(paneSkeleton()).not.toBeNull();
    await wait(1);
    expect(loadingFrame()).toBeNull();
    expect(paneSkeleton()).toBeNull();
  });

  it('never shows the skeletons when the data is ready before they would paint', async () => {
    await mount();
    await frame();
    await act(async () => useDataStore.setState({ data, status: 'ready' }));
    expect(loadingFrame()).toBeNull();
    expect(paneSkeleton()).toBeNull();
  });
});

describe('ClarityEditor loading text', () => {
  const props = {
    value: 'Loaded text',
    lang: 'en' as const,
    globals: { variables: '', titles: '' },
    onChange: () => {},
    readOnly: true,
  };
  const cover = () => host.querySelector('[data-editor-root] [aria-busy="true"]');
  const bars = () => cover()?.querySelector('[aria-hidden="true"]') ?? null;

  it('holds a painted skeleton (and keeps the editor inert) for the minimum', async () => {
    await act(async () => root.render(createElement(ClarityEditor, { ...props, pending: true })));
    await paint();
    expect(bars()).not.toBeNull();
    await wait(80);
    await act(async () => root.render(createElement(ClarityEditor, { ...props, pending: false })));
    expect(bars()).not.toBeNull();
    expect(host.querySelector('[data-editor-root]')!.hasAttribute('inert')).toBe(true);
    await wait(skeletonMinimumMs - 81);
    expect(bars()).not.toBeNull();
    await wait(1);
    expect(cover()).toBeNull();
    expect(host.querySelector('[data-editor-root]')!.hasAttribute('inert')).toBe(false);
  });

  it('never paints the skeleton when the text is ready before the second frame', async () => {
    await act(async () => root.render(createElement(ClarityEditor, { ...props, pending: true })));
    await frame();
    await act(async () => root.render(createElement(ClarityEditor, { ...props, pending: false })));
    expect(cover()).toBeNull();
  });
});

describe('PreviewColumn loading text', () => {
  const props = {
    hash: 100,
    lang: 'en' as const,
    name: 'Sample 100',
    baseText: 'Loaded preview',
    baseGlobals: { variables: '', titles: '' },
    enhanced: [],
    mode: 'base' as const,
    onMode: () => {},
    onVariant: () => {},
    variant: undefined,
  };
  const bars = () => host.querySelector('[aria-busy="true"] [aria-hidden="true"]');

  it('holds a painted skeleton for the minimum after the upcoming state resolves', async () => {
    await act(async () =>
      root.render(createElement(PreviewColumn, { ...props, loadingContent: true })),
    );
    await paint();
    expect(bars()).not.toBeNull();
    await wait(30);
    await act(async () =>
      root.render(createElement(PreviewColumn, { ...props, loadingContent: false })),
    );
    expect(bars()).not.toBeNull();
    expect(host.textContent).not.toContain('Loaded preview');
    await wait(skeletonMinimumMs - 31);
    expect(bars()).not.toBeNull();
    await wait(1);
    expect(bars()).toBeNull();
    expect(host.textContent).toContain('Loaded preview');
  });

  it('drops the hold at once for another tooltip', async () => {
    await act(async () =>
      root.render(createElement(PreviewColumn, { ...props, loadingContent: true })),
    );
    await paint();
    await act(async () =>
      root.render(
        createElement(PreviewColumn, {
          ...props,
          hash: 101,
          baseText: 'Next preview',
          loadingContent: false,
        }),
      ),
    );
    expect(bars()).toBeNull();
    expect(host.textContent).toContain('Next preview');
  });
});
