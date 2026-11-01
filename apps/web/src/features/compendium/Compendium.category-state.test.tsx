// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompendiumLink } from '@clarity/core';
import { App } from '../../App';
import { guidedFixture } from '../../../test/guided-fixture';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { itemFor } from '../navigation/catalog';
import { useCompendiumStore } from './store';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { compendiumChanges } from './tracking';

const captured = vi.hoisted(() => ({
  proposals: new Map(),
  writes: vi.fn(async (drafts: unknown) => {
    void drafts;
  }),
}));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: captured.proposals, loading: false, error: null }),
}));
vi.mock('../../services/draftStorage', () => ({
  draftStorage: { read: async () => ({}), write: captured.writes },
}));
vi.mock('../auth/AuthStatus', () => ({ AuthStatus: () => null }));
vi.mock('./CompendiumBadge', () => ({ CompendiumBadge: () => null }));
vi.mock('../../services/save/SavePanel', () => ({ SavePanel: () => null }));

const originals = {
  data: useDataStore.getState(),
  drafts: useDraftStore.getState(),
  auth: useAuthStore.getState(),
  save: useSaveState.getState(),
  compendium: useCompendiumStore.getState(),
  sidebar: useSidebarQueueStore.getState(),
};
let fixture: ReturnType<typeof guidedFixture>;
let host: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof useNavigate>;
let requests: { url: string; method: string }[];
let storageWrites: string[];

function RouteState() {
  const location = useLocation();
  navigate = useNavigate();
  return createElement('output', { 'data-route': '' }, location.pathname + location.search);
}
function route() {
  return new URL(host.querySelector('[data-route]')!.textContent!, 'https://fixture.invalid');
}
function button(text: string, parent: ParentNode = host) {
  const result = [...parent.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.trim().startsWith(text),
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
function categoryLink(text: string) {
  return [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Compendium views"] a')].find(
    (element) => element.textContent === text,
  )!;
}
async function click(text: string, parent: ParentNode = host) {
  await act(async () => button(text, parent).click());
}
async function tab(text: string) {
  await act(async () => categoryLink(text).click());
}
async function change(label: string, value: string) {
  const control = [...host.querySelectorAll('label')]
    .find((element) => element.textContent?.trim().startsWith(label))
    ?.querySelector<HTMLInputElement | HTMLSelectElement>('input,select');
  if (!control) throw new Error(`Missing ${label}`);
  await act(async () => {
    const prototype =
      control instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }),
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
        createElement(Fragment, null, createElement(RouteState), createElement(App)),
      ),
    ),
  );
}
function missingLink(): CompendiumLink {
  return {
    gid: fixture.source.tabs[0].gid,
    rowKey: 'Removed fixture row',
    snapshot: { plain: 'Prior text', runs: [{ text: 'Prior text' }] },
    snapshotAt: fixture.source.fetchedAt,
  };
}
function selectedSample() {
  return host
    .querySelector<HTMLElement>('[aria-label^="Resolve sample "]')
    ?.getAttribute('aria-label');
}
function categorySearch() {
  return host.querySelector<HTMLInputElement>('[aria-label="Review categories"] input');
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const cache = new Map<string, string>();
  storageWrites = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageWrites.push(key);
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture = guidedFixture();
  fixture.document.scope = `${bundleUrl}|${compendiumDataUrl}`;
  fixture.editor.categories = [
    { id: 'weapon-trait', label: 'Fixture traits', group: 'Fixture', order: 1 },
  ];
  captured.proposals = fixture.proposals;
  captured.writes.mockClear();
  requests = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    if (String(input).endsWith('__review-guidance') && !init?.method)
      return Response.json({ document: fixture.document, revision: 'fixture-only' });
    throw new Error(`Blocked fixture request ${input}`);
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
  });
  useAuthStore.setState({ user: null, loading: false, load: async () => {} });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({
    data: fixture.source,
    loading: false,
    error: null,
    load: async () => {},
  });
  useSidebarQueueStore.setState({ compendiumCategories: null, pendingChanges: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  const drafts = useDraftStore.getState().drafts;
  await act(async () => root.unmount());
  host.remove();
  useDataStore.setState(originals.data);
  useDraftStore.setState(originals.drafts);
  useAuthStore.setState(originals.auth);
  useSaveState.setState(originals.save);
  useCompendiumStore.setState(originals.compendium);
  useSidebarQueueStore.setState(originals.sidebar);
  vi.unstubAllGlobals();
  expect(requests.every(({ url }) => url.endsWith('__review-guidance'))).toBe(true);
  expect(drafts).toEqual({});
  expect(captured.writes.mock.calls.every(([value]) => JSON.stringify(value) === '{}')).toBe(true);
});

it('preserves the real selected sample and category search through a linked-tab return', async () => {
  await mount('/compendium');
  await click('2. Sample 101', host.querySelector('[aria-label="Representative samples"]')!);
  expect(route().searchParams.get('guideSample:catalog:weapon-trait')).toBe('101');
  await change('Find category', 'trait');
  expect(selectedSample()).toBe('Resolve sample Sample 101');
  expect(categorySearch()?.value).toBe('trait');

  await tab('Linked sources changed');
  expect(host.querySelector('[aria-label="Category guidance"]')).toBeNull();
  await tab('Review matches');

  expect.soft(selectedSample()).toBe('Resolve sample Sample 101');
  expect.soft(categorySearch()?.value).toBe('trait');
});

it('restores the real selected sample and category search on router Back and Forward', async () => {
  await mount('/compendium');
  await click('2. Sample 101', host.querySelector('[aria-label="Representative samples"]')!);
  expect(route().searchParams.get('guideSample:catalog:weapon-trait')).toBe('101');
  await change('Find category', 'trait');
  await tab('Linked sources changed');

  await go(-1);
  expect(route().searchParams.get('tab')).toBeNull();
  expect.soft(selectedSample()).toBe('Resolve sample Sample 101');
  expect.soft(categorySearch()?.value).toBe('trait');
  await go(1);
  expect(route().searchParams.get('tab')).toBe('linked');
  expect(host.querySelector('[aria-label="Category guidance"]')).toBeNull();
  await go(-1);
  expect.soft(selectedSample()).toBe('Resolve sample Sample 101');
  expect.soft(categorySearch()?.value).toBe('trait');
});

it('retains the active category state across entry review and workspace leave/return', async () => {
  await mount('/compendium');
  await click('2. Sample 101', host.querySelector('[aria-label="Representative samples"]')!);
  expect(route().searchParams.get('guideSample:catalog:weapon-trait')).toBe('101');
  await change('Find category', 'trait');
  await click('Review all one by one');
  expect(route().searchParams.get('view')).toBe('entries');
  await click('Back to category guidance');
  expect(selectedSample()).toBe('Resolve sample Sample 101');
  expect(categorySearch()?.value).toBe('trait');

  await change('Workspace', '/review');
  await change('Workspace', '/compendium');
  expect(route().pathname).toBe('/compendium');
  expect(selectedSample()).toBe('Resolve sample Sample 101');
  expect(categorySearch()?.value).toBe('trait');
});

it('keeps linked filters active and does not retain an interactive review queue', async () => {
  fixture.editor.bundle.tooltips[103] = {
    hash: 103,
    text: {},
    associated: [],
    compendium: missingLink(),
  };
  await mount('/compendium');
  await click('2. Sample 101', host.querySelector('[aria-label="Representative samples"]')!);
  await change('Find category', 'trait');
  await tab('Linked sources changed');
  await change('Search tooltips', 'Sample 103');
  await change('Category', 'weapon-trait');
  expect(route().searchParams.get('linkedQuery')).toBe('Sample 103');
  expect(route().searchParams.get('linkedCategory')).toBe('weapon-trait');
  expect(host.querySelector('[aria-label="Category guidance"]')).toBeNull();
  expect(host.querySelector('[aria-label="Entry to review"]')).toBeNull();
  expect(host.querySelectorAll('nav[aria-label="Compendium views"] a')).toHaveLength(2);

  const before = {
    drafts: useDraftStore.getState().drafts,
    requests: requests.length,
    storageWrites: storageWrites.length,
    text: host.textContent,
  };
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 400 }));
  });
  expect(useDraftStore.getState().drafts).toEqual(before.drafts);
  expect(requests).toHaveLength(before.requests);
  expect(storageWrites).toHaveLength(before.storageWrites);
  expect(host.textContent).toBe(before.text);
});

it('keeps zero/populated linked counts aligned with existing canonical selectors', async () => {
  await mount('/compendium?tab=linked');
  expect(button('Linked sources changed (0)')).toBeTruthy();
  expect(button('Tooltips without links (6)')).toBeTruthy();

  fixture.editor.bundle.tooltips[103] = {
    hash: 103,
    text: {},
    associated: [],
    compendium: missingLink(),
  };
  const newCompendium = {
    ...fixture.source,
    tabs: fixture.source.tabs.map((tab) => ({
      ...tab,
      rows: tab.rows.filter((row) => row.name !== 'Sample 100'),
    })),
  };
  useDataStore.setState({ data: structuredClone(fixture.editor) });
  useCompendiumStore.setState({ data: newCompendium });
  await act(async () => {});

  expect(
    button(
      `Linked sources changed (${compendiumChanges(fixture.editor.bundle.tooltips, newCompendium).length})`,
    ),
  ).toBeTruthy();
  const expectedMissing = Object.values(fixture.editor.items)
    .map(({ hash }) => hash)
    .filter(
      (hash) =>
        !fixture.editor.bundle.tooltips[hash]?.compendium && !!itemFor(hash, fixture.editor),
    );
  expect(button(`Tooltips without links (${expectedMissing.length})`)).toBeTruthy();
});
