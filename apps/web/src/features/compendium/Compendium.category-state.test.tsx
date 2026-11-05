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
vi.mock('../auth/AuthStatus', () => ({
  useAuthSession: () => undefined,
  IdentityStatus: () => null,
  identitySummary: () => ({ label: 'Account', detail: 'Account', tone: 'out' }),
}));
vi.mock('./CompendiumBadge', () => ({
  CompendiumBadge: () => null,
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));
vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));

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
async function workspace(path: string) {
  const link = host.querySelector<HTMLAnchorElement>(
    `nav[aria-label="Workspaces"] a[href^="${path}"]`,
  );
  if (!link) throw new Error(`Missing workspace tab ${path}`);
  await act(async () => link.click());
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
  await act(async () => {
    await vi.dynamicImportSettled();
  });
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
    activate: async () => {},
  });
  useAuthStore.setState({
    user: { id: 1, login: 'fixture', role: 'maintainer' },
    loading: false,
    load: async () => {},
  });
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
  window.dispatchEvent(new Event('pagehide'));
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

it.each([false, true])(
  'leaves guidance bytes unchanged while opening and navigating (existing backup: %s)',
  async (existing) => {
    const key = `clarity-review-guidance:v1:${encodeURIComponent(`${bundleUrl}|${compendiumDataUrl}`)}`;
    const original = existing
      ? JSON.stringify(
          { document: fixture.document, revision: 'fixture-only', pending: true },
          null,
          2,
        )
      : null;
    if (original) localStorage.setItem(key, original);
    storageWrites.length = 0;
    await mount('/compendium');
    await click('2. Sample 101', host.querySelector('[aria-label="Representative samples"]')!);
    await change('Find category', 'trait');
    await click('Review all one by one');
    await change('Show', 'all');
    await click('Back to category guidance');
    await tab('Linked sources changed');
    await tab('Review matches');
    await workspace('/review');
    await workspace('/compendium');
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(localStorage.getItem(key)).toBe(original);
    expect(storageWrites.filter((key) => key.startsWith('clarity-review-guidance:'))).toEqual([]);
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  },
);

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

  await workspace('/review');
  await workspace('/compendium');
  expect(route().pathname).toBe('/compendium');
  expect(selectedSample()).toBe('Resolve sample Sample 101');
  expect(categorySearch()?.value).toBe('trait');
});

it('reuses static category navigation while resetting inactive search and sample controls', async () => {
  await mount('/compendium');
  const guidance = host.querySelector<HTMLElement>('[aria-label="Category guidance"]')!;
  const list = guidance.querySelector<HTMLElement>('[class*="categoryButtons"]')!;
  const category = list.querySelector('button')!;
  const search = categorySearch();
  const sample = guidance.querySelector('[aria-label^="Resolve sample "]');
  list.scrollTop = 80;
  const details = guidance.querySelector('details')!;
  details.open = true;
  await click('Review all one by one');
  expect(guidance.hidden).toBe(true);
  expect(guidance.querySelector('[aria-label^="Resolve sample "]')).toBeNull();
  expect(guidance.querySelector('input')).toBeNull();
  expect(list.querySelector('button')).toBe(category);
  await click('Back to category guidance');
  expect(guidance.hidden).toBe(false);
  expect(list.scrollTop).toBe(0);
  expect(list.querySelector('button')).toBe(category);
  expect(categorySearch()).not.toBe(search);
  expect(guidance.querySelector('[aria-label^="Resolve sample "]')).not.toBe(sample);
  expect(guidance.querySelector('details')!.open).toBe(false);
});

it('creates retained category navigation only after category guidance is visited', async () => {
  await mount('/compendium/review?view=entries&group=catalog%3Aweapon-trait&hash=100');
  expect(host.querySelector('[aria-label="Entry to review"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Category guidance"]')).toBeNull();
  await click('Back to category guidance');
  const guidance = host.querySelector<HTMLElement>('[aria-label="Category guidance"]')!;
  expect(guidance.hidden).toBe(false);
  await click('Review all one by one');
  expect(host.querySelector('[aria-label="Category guidance"]')).toBe(guidance);
  expect(guidance.hidden).toBe(true);
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
  expect(
    [...host.querySelectorAll('nav[aria-label="Compendium views"] a')].map(
      (link) => link.textContent,
    ),
  ).toEqual(['Matched sources', 'Review matches', 'Linked sources changed']);

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

it('keeps notes mounted through disclosures and modal Back without background decisions', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
  await mount('/compendium');
  const sample = host.querySelector('[aria-label^="Resolve sample "]')!;
  const disclosure = [...sample.querySelectorAll('details')].find(
    (node) => node.querySelector('summary')?.textContent === 'Example note',
  )!;
  expect(disclosure.open).toBe(false);
  expect(sample.querySelector('textarea')).toBeNull();
  await act(async () => disclosure.querySelector('summary')!.click());
  const note = sample.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      note,
      'Unsaved owner reasoning',
    );
    note.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => disclosure.querySelector('summary')!.click());
  expect(sample.querySelector('textarea')).toBe(note);
  expect(note.value).toBe('Unsaved owner reasoning');
  const pick = button('Pick other', sample);
  pick.focus();
  await act(async () => pick.click());
  const modal = document.querySelector<HTMLDialogElement>('dialog[open]')!;
  expect(modal).not.toBeNull();
  expect(modal.contains(document.activeElement)).toBe(true);
  const before = storageWrites.length;
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
  });
  expect(storageWrites).toHaveLength(before);
  await act(async () => button('Back', modal).click());
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(document.activeElement).toBe(pick);
  expect(note.value).toBe('Unsaved owner reasoning');
  expect(disclosure.open).toBe(false);
});

it('keeps category decisions as local references and exposes export failures', async () => {
  await mount('/compendium');
  const scope = `${bundleUrl}|${compendiumDataUrl}`;
  const cacheKey = `clarity-review-guidance:v1:${encodeURIComponent(scope)}`;
  const read = () =>
    JSON.parse(localStorage.getItem(cacheKey)!).document.categories['catalog:weapon-trait']
      .references[100];
  const initialRoute = route().search;
  for (const [action, decision] of [
    ['No equivalent', 'no-equivalent'],
    ['Skip', 'skipped'],
    ['Accept proposed link', 'accepted'],
  ]) {
    await click(action);
    expect(read().decision).toBe(decision);
    expect(route().search).toBe(initialRoute);
    expect(useDraftStore.getState().drafts).toEqual({});
  }
  await click('Clear decision');
  expect(read().decision).toBeUndefined();
  const descriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      throw new Error('<html>download unavailable</html>');
    },
  });
  try {
    await act(async () => {
      [...host.querySelectorAll('summary')].find((node) => node.textContent === 'Details')!.click();
      [...host.querySelectorAll('summary')]
        .find((node) => node.textContent === 'Backup / recovery')!
        .click();
    });
    await click('Export backup');
    expect(host.textContent).toContain('Backup export failed: download unavailable');
    expect(host.querySelector('html')).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(URL, 'createObjectURL', descriptor);
    else Reflect.deleteProperty(URL, 'createObjectURL');
  }
});
