// @vitest-environment jsdom
import { skeletonMinimumMs } from '../../ui/Skeleton';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumLink } from '@clarity/core';
import { App } from '../../App';
import { guidedFixture } from '../../../test/guided-fixture';
import { useCompendiumStore } from './store';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';

const captured = vi.hoisted(() => ({ proposals: new Map() }));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: captured.proposals, loading: false, error: null }),
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
vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));

const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
const originalSave = useSaveState.getState();
const originalCompendium = useCompendiumStore.getState();
const originalSidebar = useSidebarQueueStore.getState();
let host: HTMLDivElement;
let root: Root;
let fixture: ReturnType<typeof guidedFixture>;
let navigate: ReturnType<typeof useNavigate>;

class FixtureResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    void callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function LocationState() {
  const location = useLocation();
  navigate = useNavigate();
  return createElement('output', { 'data-route': '' }, location.pathname + location.search);
}

function route() {
  return new URL(host.querySelector('[data-route]')!.textContent!, 'https://synthetic.invalid');
}

function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.startsWith(text),
  );
  if (!found) throw new Error(`Missing button ${text}: ${host.textContent}`);
  return found;
}

function link(text: string) {
  const found = [...host.querySelectorAll('a')].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing link ${text}: ${host.textContent}`);
  return found;
}

async function clickLink(text: string) {
  await act(async () => link(text).click());
}

async function change(label: string, value: string) {
  const input = [...host.querySelectorAll('label')]
    .find((element) => element.textContent?.trim().startsWith(label))
    ?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  if (!input) throw new Error(`Missing control ${label}: ${host.textContent}`);
  await act(async () => {
    const prototype =
      input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }),
    );
  });
}

async function go(target: string | number) {
  await act(async () => {
    if (typeof target === 'number') await navigate(target);
    else await navigate(target);
  });
}

async function mount(path: string) {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Fragment, null, createElement(LocationState), createElement(App)),
      ),
    ),
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  // A loading skeleton that showed stays for its minimum time before the content swaps in.
  await act(() => new Promise((resolve) => setTimeout(resolve, skeletonMinimumMs + 20)));
}

function missingLink(rowKey: string): CompendiumLink {
  return {
    gid: fixture.source.tabs[0].gid,
    rowKey,
    snapshot: { plain: 'Previously linked text', runs: [{ text: 'Previously linked text' }] },
    snapshotAt: '2026-11-01T00:00:00Z',
  };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
  fixture = guidedFixture();
  fixture.document.scope = `${bundleUrl}|${compendiumDataUrl}`;
  captured.proposals = fixture.proposals;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      throw new Error(`Blocked network: ${url}`);
    }),
  );
  vi.stubGlobal('ResizeObserver', FixtureResizeObserver);
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
  useAuthStore.setState({ user: null, loading: false });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({
    data: fixture.source,
    loading: false,
    error: null,
    refreshing: false,
    refreshMessage: null,
    load: async () => {},
    refresh: async () => {},
  });
  useSidebarQueueStore.setState({ pendingChanges: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await useDraftStore.getState().flush();
  host.remove();
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  useSaveState.setState(originalSave);
  useCompendiumStore.setState(originalCompendium);
  useSidebarQueueStore.setState(originalSidebar);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const title = () =>
  host.querySelector('[aria-label="Entry to review"] [role="heading"]')?.textContent ?? '';

describe('Compendium route and linked-source view', () => {
  it('lists the queue beside the first entry and keeps selection in the URL', async () => {
    await mount('/compendium');

    expect(host.querySelector('[aria-label="Compendium review queue"]')).not.toBeNull();
    expect(host.querySelector('header p')?.textContent).toContain('6 to review');
    expect(title()).toContain('Sample 100');
    // Selecting a row replaces history: Back leaves the page, not the previous entry.
    const rows = host.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"]');
    expect(rows).toHaveLength(6);
    await act(async () => rows[2].click());
    expect(route().pathname).toBe('/compendium');
    expect(route().searchParams.get('hash')).toBe('102');
    expect(title()).toContain('Sample 102');
  });

  it('opens direct entry links on that entry, even when filters would hide it', async () => {
    await mount('/compendium?hash=105&q=zzz');
    expect(title()).toContain('Sample 105');
    expect(route().searchParams.get('hash')).toBe('105');
    expect(host.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent).toContain(
      'outside filter',
    );
  });

  it('sends the retired review URLs to the tab, keeping the entry and mapping the category', async () => {
    await mount('/compendium/review?view=entries&group=catalog%3Aweapon-trait&hash=105');
    expect(route().pathname).toBe('/compendium');
    expect(route().searchParams.get('hash')).toBe('105');
    expect(route().searchParams.get('group')).toBe('weapon-trait');
    expect(route().searchParams.has('view')).toBe(false);
    expect(title()).toContain('Sample 105');
  });

  it('labels zero linked changes separately from the real unlinked-tooltip count', async () => {
    await mount('/compendium?tab=linked');

    expect(button('Linked sources changed (0)')).toBeTruthy();
    expect(button('Tooltips without links (6)')).toBeTruthy();
    expect(host.textContent).toContain('No linked Compendium changes match these filters.');
    expect(host.textContent).not.toContain('all matching complete');
  });

  it('retains populated linked-source entries, filters, and history across the queue', async () => {
    fixture.editor.categories = [
      { id: 'weapon-trait', label: 'Traits', group: 'Weapons', order: 1 },
    ];
    fixture.editor.bundle.tooltips[100] = {
      hash: 100,
      text: {},
      associated: [],
      compendium: missingLink('Missing 100'),
    };
    fixture.editor.bundle.tooltips[101] = {
      hash: 101,
      text: {},
      associated: [],
      compendium: missingLink('Missing 101'),
    };
    await mount('/compendium?hash=100&show=all');
    expect(title()).toContain('Sample 100');

    await clickLink('Linked (2)');
    expect(route().searchParams.get('tab')).toBe('linked');
    expect(button('Linked sources changed (2)')).toBeTruthy();
    expect(button('Tooltips without links (4)')).toBeTruthy();
    expect(link('Sample 100').getAttribute('href')).toBe('/t/100');

    await change('Search tooltips', 'Sample 101');
    expect(route().searchParams.get('hash')).toBe('100');
    expect(route().searchParams.get('show')).toBe('all');
    expect(route().searchParams.get('linkedQuery')).toBe('Sample 101');
    expect(host.querySelectorAll('main article section ul > li')).toHaveLength(1);
    await clickLink('Sample 101');
    expect(route().pathname).toBe('/t/101');

    await go(-1);
    expect(route().searchParams.get('tab')).toBe('linked');
    expect(route().searchParams.get('linkedQuery')).toBe('Sample 101');
    await clickLink('Back to the review queue');
    expect(route().searchParams.has('tab')).toBe(false);
    expect(route().searchParams.get('hash')).toBe('100');
    expect(title()).toContain('Sample 100');
  });
});
