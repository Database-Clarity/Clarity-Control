// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { ReviewQueue } from './MatchReviewPage';
import { categoryId } from './reviewCategories';
import { displayMatches } from './displayMatches';
import { useCompendiumStore } from './store';
import { emptyProgress, type ReviewProgress } from './reviewProgress';
import { Layout } from '../navigation/Layout';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';

const captured = vi.hoisted(() => ({ proposals: new Map(), save: vi.fn() }));
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://synthetic.invalid',
  save: captured.save,
}));
vi.mock('../../services/draftStorage', () => ({
  draftStorage: { read: async () => ({}), write: async () => {} },
}));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: captured.proposals, loading: false }),
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

const storageKey = 'synthetic-navigation-review';
const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
const originalSave = useSaveState.getState();
const originalCompendium = useCompendiumStore.getState();
const modalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
let host: HTMLDivElement;
let root: Root;
let fixture: ReturnType<typeof guidedFixture>;
let navigate: ReturnType<typeof useNavigate>;

function RouteState() {
  const location = useLocation();
  navigate = useNavigate();
  return createElement('output', { 'data-route': '' }, location.pathname + location.search);
}

function route() {
  return new URL(host.querySelector('[data-route]')!.textContent!, 'https://synthetic.invalid');
}

function selected() {
  return host.querySelector('[aria-label="Entry to review"] h2')?.textContent;
}

function progress(): ReviewProgress {
  return JSON.parse(localStorage.getItem(storageKey)!);
}

function button(text: string, within: ParentNode = host) {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));
  if (!found) throw new Error(`Missing button ${text}: ${within.textContent}`);
  return found;
}

function control<T extends HTMLInputElement | HTMLSelectElement>(label: string) {
  const found = [...document.querySelectorAll('label')]
    .find((element) => element.textContent?.trim().startsWith(label))
    ?.querySelector<T>('input, select');
  if (!found) throw new Error(`Missing control ${label}`);
  return found;
}

async function click(text: string, within: ParentNode = host) {
  await act(async () => button(text, within).click());
}

async function change(label: string, value: string) {
  await act(async () => {
    const input = control(label);
    const prototype =
      input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }),
    );
  });
}

async function key(
  key: string,
  target: EventTarget = document.activeElement ?? window,
  shiftKey = false,
) {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}

async function go(target: string | number) {
  await act(async () => {
    if (typeof target === 'number') await navigate(target);
    else await navigate(target);
  });
}

function categoryRoute(category = 'weapon-trait', hash?: number) {
  const params = new URLSearchParams({ view: 'entries', group: categoryId(category) });
  if (hash !== undefined) params.set('hash', String(hash));
  return `/compendium/review?${params}`;
}

async function mount(
  path = '/compendium/review?view=entries&hash=100',
  stored = emptyProgress(),
  prepared?: ReturnType<typeof displayMatches>,
) {
  localStorage.setItem(storageKey, JSON.stringify(stored));
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Fragment,
          null,
          createElement(RouteState),
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, {
                path: '*',
                element: createElement(ReviewQueue, {
                  editor: fixture.editor,
                  source: fixture.source,
                  storageKey,
                  prepared,
                }),
              }),
            ),
          ),
        ),
      ),
    ),
  );
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
  useCompendiumStore.setState({ data: fixture.source, loading: false, error: null });
  captured.proposals = fixture.proposals;
  captured.save.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('__review-guidance') && !init?.method)
        return Response.json({ document: fixture.document, revision: 'synthetic-revision' });
      throw new Error(`Blocked network: ${url}`);
    }),
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
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
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'editor' }, loading: false });
  useSaveState.setState({ locked: false, review: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  // A browser lifecycle flush ends this fixture's deferred navigation session.
  window.dispatchEvent(new Event('pagehide'));
  await useDraftStore.getState().flush();
  host.remove();
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  useSaveState.setState(originalSave);
  useCompendiumStore.setState(originalCompendium);
  useSidebarQueueStore.setState({ compendiumCategories: null, pendingChanges: null });
  document.body.style.overflow = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ['showModal', modalDescriptor],
    ['close', closeDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

describe('reviewed URL/decision reproductions', () => {
  it('states local consequences inside the individual decision bar', async () => {
    await mount();
    const bar = host.querySelector<HTMLElement>('footer[aria-label="Review actions"]')!;
    expect(bar.querySelector('p')?.textContent).toBe(
      'Links create local drafts, not saves · Skip/No equivalent stay in browser.',
    );
    expect(
      [...bar.querySelectorAll('button')].map((element) => element.textContent?.trim()),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Accept proposed link'),
        expect.stringContaining('Pick other'),
        expect.stringContaining('No equivalent'),
        expect.stringContaining('Skip'),
      ]),
    );
    expect(bar.querySelectorAll('button')).toHaveLength(5);
  });

  it('Next changes the mounted entry and URL from 100 to 101 in All entries', async () => {
    await mount();
    await change('Show', 'all');
    expect(selected()).toBe('Sample 100');
    await click('Next');
    expect(selected()).toBe('Sample 101');
    expect(route().searchParams.get('hash')).toBe('101');
    expect(progress().selected).not.toBe(101);
    window.dispatchEvent(new Event('pagehide'));
    expect(progress().selected).toBe(101);
  });

  it('matches the in-bar consequence to current linking permissions without changing actions', async () => {
    await mount();
    const bar = host.querySelector<HTMLElement>('footer[aria-label="Review actions"]')!;
    const drafts = useDraftStore.getState().drafts;
    const decisions = progress().decisions;
    const user = useAuthStore.getState().user;
    expect(button('Accept proposed link', bar).disabled).toBe(false);

    await act(async () => useAuthStore.setState({ user: null }));
    expect(bar.querySelector('p')?.textContent).toBe(
      'Browsing only · linking unavailable · Pick other previews sources; Skip/No equivalent stay in browser.',
    );
    expect(button('Accept proposed link', bar).disabled).toBe(true);
    expect(button('Pick other', bar).disabled).toBe(false);
    expect(button('No equivalent', bar).disabled).toBe(false);
    expect(button('Skip', bar).disabled).toBe(false);

    await click('Pick other', bar);
    expect(button('Accept proposed link', bar).disabled).toBe(true);
    expect(bar.querySelector('p')?.textContent).toContain('linking unavailable');
    await click('Pick other', bar);

    await act(async () => useAuthStore.setState({ user }));
    expect(bar.querySelector('p')?.textContent).toContain('Links create local drafts, not saves');
    expect(button('Accept proposed link', bar).disabled).toBe(false);

    await act(async () => useSaveState.setState({ locked: true }));
    expect(bar.querySelector('p')?.textContent).toContain('linking unavailable');
    expect(button('Accept proposed link', bar).disabled).toBe(true);
    await act(async () => useSaveState.setState({ locked: false }));

    expect(bar.querySelector('p')?.textContent).toContain('Links create local drafts, not saves');
    expect(button('Accept proposed link', bar).disabled).toBe(false);
    expect(useDraftStore.getState().drafts).toBe(drafts);
    expect(progress().decisions).toEqual(decisions);
  });

  it('Skip advances in All entries while keeping the local decision reachable', async () => {
    await mount();
    await change('Show', 'all');
    await click('Skip');
    expect(selected()).toBe('Sample 101');
    expect(route().searchParams.get('hash')).toBe('101');
    expect(progress().decisions[100].kind).toBe('skipped');
    await click('← Previous');
    expect(selected()).toBe('Sample 100');
    expect(button('Reopen decision').disabled).toBe(false);
  });

  it('Skip then Undo in Unresolved restores the actual routed entry, not stale storage', async () => {
    await mount(undefined, { ...emptyProgress(), selected: 105 });
    expect(selected()).toBe('Sample 100');
    await click('Skip');
    expect(selected()).toBe('Sample 101');
    await click('Undo last');
    expect(selected()).toBe('Sample 100');
    expect(route().searchParams.get('hash')).toBe('100');
    expect(progress().selected).toBe(100);
    expect(progress().decisions).toEqual({});
  });
});

describe('category filtering and history', () => {
  it('category browse selects the requested entry, clears stale filters, and survives Back/Forward', async () => {
    await mount('/compendium/review', {
      ...emptyProgress(),
      query: 'not found',
      filter: 'skipped',
    });
    const browse = [...host.querySelectorAll('details')].find((element) =>
      element.querySelector('summary')?.textContent?.startsWith('Browse / category'),
    )!;
    expect(browse).not.toBeNull();
    expect(browse.querySelector('button')).toBeNull();
    await act(async () => browse.querySelector('summary')!.click());
    await click('Sample 105', browse);
    expect(selected()).toBe('Sample 105');
    expect(route().searchParams.get('hash')).toBe('105');
    expect(route().searchParams.get('group')).toBe(categoryId('weapon-trait'));
    expect(control<HTMLInputElement>('Find entry').value).toBe('');
    expect(control<HTMLSelectElement>('Show').value).toBe('open');
    await go(-1);
    expect(selected()).toBeUndefined();
    expect(host.textContent).toContain('Resolve a few examples');
    await go(1);
    expect(selected()).toBe('Sample 105');
  });

  it('search on a category route actually displays Sample 105 rather than 100', async () => {
    await mount(categoryRoute());
    await change('Find entry', 'Sample 105');
    expect(selected()).toBe('Sample 105');
    expect(route().searchParams.get('hash')).toBe('105');
    expect(host.textContent).toContain('1 / 1 in filter');
  });

  it('Show skipped on a category route displays 100 and permits Reopen and Undo', async () => {
    await mount(categoryRoute());
    await click('Skip');
    expect(selected()).toBe('Sample 101');
    await change('Show', 'skipped');
    expect(selected()).toBe('Sample 100');
    expect(button('Reopen decision').disabled).toBe(false);
    await click('Reopen decision');
    expect(selected()).toBeUndefined();
    expect(host.textContent).toContain('Filter complete');
    expect(progress().decisions[100].kind).toBe('open');
    await click('Undo last');
    expect(selected()).toBe('Sample 100');
    expect(control<HTMLSelectElement>('Show').value).toBe('skipped');
    expect(progress().decisions[100].kind).toBe('skipped');
    await click('Reopen decision');
    await change('Show', 'open');
    expect(selected()).toBe('Sample 100');
    expect(host.textContent).toContain('1 / 6 in filter');
  });

  it('honors proposal filters within the selected category', async () => {
    fixture.proposals.delete(105);
    await mount(categoryRoute());
    await change('Proposal', 'no');
    expect(selected()).toBe('Sample 105');
    expect(host.textContent).toContain('1 / 1 in filter');
    await change('Proposal', 'yes');
    expect(selected()).toBe('Sample 100');
    expect(host.textContent).toContain('1 / 5 in filter');
  });

  it('changing category preserves the existing query, status and proposal filters', async () => {
    fixture.editor.categories = [
      { id: 'weapon-trait', label: 'Traits', group: 'Weapons', order: 1 },
      { id: 'armor-perk', label: 'Armor', group: 'Armor', order: 2 },
    ];
    fixture.editor.items[200] = {
      hash: 200,
      name: 'Armor 200',
      categoryId: 'armor-perk',
      icon: '',
      inGameDescription: 'A non-stat armor effect',
    };
    await mount(categoryRoute());
    await change('Find entry', '100');
    await change('Show', 'all');
    await change('Proposal', 'yes');
    await change('Category', 'armor-perk');
    expect(selected()).toBeUndefined();
    expect(control<HTMLInputElement>('Find entry').value).toBe('100');
    expect(control<HTMLSelectElement>('Show').value).toBe('all');
    expect(control<HTMLSelectElement>('Proposal').value).toBe('yes');
    expect(route().searchParams.has('group')).toBe(false);
    expect(route().searchParams.get('category')).toBe('armor-perk');
    await change('Find entry', '');
    expect(selected()).toBeUndefined();
    await change('Proposal', 'no');
    expect(selected()).toBe('Armor 200');
  });

  it('normalizes stale filters on category entry, not each render or history return', async () => {
    fixture.editor.items[200] = {
      hash: 200,
      name: 'Armor 200',
      categoryId: 'armor-perk',
      icon: '',
      inGameDescription: 'A non-stat armor effect',
    };
    await mount(undefined, {
      ...emptyProgress(),
      query: 'not found',
      filter: 'skipped',
      category: 'other',
    });
    expect(selected()).toBeUndefined();
    await go(categoryRoute());
    expect(selected()).toBe('Sample 100');
    expect(control<HTMLInputElement>('Find entry').value).toBe('');
    expect(control<HTMLSelectElement>('Show').value).toBe('open');
    await click('Skip');
    await change('Show', 'skipped');
    await change('Find entry', '100');
    await change('Proposal', 'yes');
    const previousRoute = route().pathname + route().search;

    const armorLink = [
      ...host.querySelectorAll<HTMLAnchorElement>('[aria-label="Compendium category queue"] a'),
    ].find(
      (link) =>
        new URL(link.getAttribute('href')!, 'https://synthetic.invalid').searchParams.get(
          'group',
        ) === categoryId('armor-perk'),
    )!;
    expect(armorLink).not.toBeNull();
    const target = new URL(armorLink.getAttribute('href')!, 'https://synthetic.invalid');
    expect(target.searchParams.get('hash')).toBe('200');
    expect(target.searchParams.get('query')).toBe('');
    expect(target.searchParams.get('status')).toBe('open');
    expect(target.searchParams.get('proposal')).toBe('all');
    await act(async () => armorLink.click());
    expect(selected()).toBe('Armor 200');
    expect(control<HTMLInputElement>('Find entry').value).toBe('');
    expect(control<HTMLSelectElement>('Show').value).toBe('open');
    expect(control<HTMLSelectElement>('Proposal').value).toBe('all');
    await go(-1);
    expect(route().pathname + route().search).toBe(previousRoute);
    expect(selected()).toBe('Sample 100');
    expect(control<HTMLInputElement>('Find entry').value).toBe('100');
    expect(control<HTMLSelectElement>('Show').value).toBe('skipped');
    expect(control<HTMLSelectElement>('Proposal').value).toBe('yes');
    expect(
      host.querySelector('[aria-label="Compendium category queue"] a[aria-current="page"]')
        ?.textContent,
    ).toContain('weapon-trait');
    await go(1);
    expect(selected()).toBe('Armor 200');
    expect(route().searchParams.get('group')).toBe(categoryId('armor-perk'));
  });

  it('honors entry deep links and Back/Forward rather than persisted selection', async () => {
    await mount('/compendium/review?view=entries&hash=105', { ...emptyProgress(), selected: 100 });
    expect(selected()).toBe('Sample 105');
    await click('← Previous');
    expect(selected()).toBe('Sample 104');
    await go(-1);
    expect(selected()).toBe('Sample 105');
    await go(1);
    expect(selected()).toBe('Sample 104');
    await go('/compendium/review?view=entries&hash=102');
    expect(selected()).toBe('Sample 102');
    await go(-1);
    expect(selected()).toBe('Sample 104');
  });

  it('clears an exhausted filter hash and Undo restores the only entry and filters', async () => {
    await mount(categoryRoute());
    await change('Find entry', '105');
    await click('Skip');
    expect(selected()).toBeUndefined();
    expect(route().searchParams.has('hash')).toBe(false);
    await click('Undo last');
    expect(selected()).toBe('Sample 105');
    expect(control<HTMLInputElement>('Find entry').value).toBe('105');
    expect(route().searchParams.get('hash')).toBe('105');
  });

  it('Accept advances, and entry Undo restores only link metadata and selection', async () => {
    await mount();
    await click('Accept proposed');
    expect(selected()).toBe('Sample 101');
    expect(route().searchParams.get('hash')).toBe('101');
    expect(useDraftStore.getState().drafts[100].next.compendium).toEqual(
      fixture.proposals.get(100)!.link,
    );
    await act(async () =>
      useDraftStore
        .getState()
        .edit(
          useDraftStore.getState().drafts[100].base,
          'en',
          'Keep later authored text',
          'fixture',
        ),
    );
    await click('Undo last');
    expect(selected()).toBe('Sample 100');
    expect(useDraftStore.getState().drafts[100].next.compendium).toBeUndefined();
    expect(useDraftStore.getState().drafts[100].next.text.en?.text).toBe(
      'Keep later authored text',
    );
  });

  it('manual picker linking advances the route and Undo restores the pre-link entry', async () => {
    await mount();
    await click('Pick other');
    const picker = document.querySelector('dialog[open][aria-label="Choose Compendium source"]')!;
    await change('Find row by name / section', 'Sample 105');
    await click('Exact match: Sample 105', picker);
    expect(selected()).toBe('Sample 101');
    expect(route().searchParams.get('hash')).toBe('101');
    expect(
      document.querySelector('dialog[open][aria-label="Choose Compendium source"]'),
    ).toBeNull();
    expect(useDraftStore.getState().drafts[100].next.compendium?.rowKey).toBe('Sample 105');
    await click('Undo last');
    expect(selected()).toBe('Sample 100');
    expect(useDraftStore.getState().drafts).toEqual({});
  });

  it('bulk linking clears a completed queue hash and Undo restores the original route', async () => {
    await mount(categoryRoute('weapon-trait', 105));
    await click('Bulk preview');
    const preview = host.querySelector('[aria-label="Bulk accept preview"]')!;
    await click('Accept 6 proposals', preview);
    expect(selected()).toBeUndefined();
    expect(route().searchParams.has('hash')).toBe(false);
    expect(Object.keys(useDraftStore.getState().drafts).sort()).toEqual([
      '100',
      '101',
      '102',
      '103',
      '104',
      '105',
    ]);
    await click('Undo last');
    expect(selected()).toBe('Sample 105');
    expect(route().searchParams.get('hash')).toBe('105');
    expect(useDraftStore.getState().drafts).toEqual({});
  });
});

describe('Shell overlay and save-dialog keyboard ownership', () => {
  const draftsButton = () => host.querySelector<HTMLButtonElement>('[data-drafts-button]')!;
  const overlay = () => document.querySelector<HTMLElement>('[data-shell-overlay]');
  const openDrafts = async () => {
    await act(async () => draftsButton().click());
  };

  it.each(['a', 's'])(
    'an open Drafts popover blocks background %s without mutations',
    async (shortcut) => {
      await mount();
      await openDrafts();
      expect(overlay()).not.toBeNull();
      const inside = overlay()!.querySelector<HTMLElement>('button')!;
      inside.focus();
      const beforeRoute = route().href;
      const beforeProgress = localStorage.getItem(storageKey);
      await key(shortcut, inside);
      expect(useDraftStore.getState().drafts).toEqual({});
      expect(localStorage.getItem(storageKey)).toBe(beforeProgress);
      expect(route().href).toBe(beforeRoute);
      expect(selected()).toBe('Sample 100');
      expect(host.querySelector('#shell-root')!.hasAttribute('inert')).toBe(true);
    },
  );

  it.each(['Escape', 'outside click'])(
    'closing the Drafts popover by %s restores focus and normal shortcuts',
    async (closeWith) => {
      await mount();
      await openDrafts();
      const inside = overlay()!.querySelector<HTMLElement>('button')!;
      if (closeWith === 'Escape') await key('Escape', inside);
      else
        await act(async () => {
          document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
      expect(overlay()).toBeNull();
      expect(document.activeElement).toBe(draftsButton());
      expect(host.querySelector('#shell-root')!.hasAttribute('inert')).toBe(false);
      expect(selected()).toBe('Sample 100');
      expect(document.body.style.overflow).toBe('');
      await key('s', window);
      expect(selected()).toBe('Sample 101');
      expect(progress().decisions[100].kind).toBe('skipped');
      await key('u', window);
      expect(selected()).toBe('Sample 100');
      await key('a', window);
      expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['100']);
      expect(selected()).toBe('Sample 101');
    },
  );

  it('keeps Tab inside the popover without consuming typing or changing the selection', async () => {
    await mount(categoryRoute());
    await click('Accept proposed');
    await openDrafts();
    const items = [...overlay()!.querySelectorAll<HTMLElement>('button:not([disabled])')];
    expect(items.length).toBeGreaterThan(1);
    const first = items[0];
    const last = items.at(-1)!;
    first.focus();
    expect((await key('Tab', first, true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect((await key('Tab', last)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const before = progress();
    expect((await key('a', first)).defaultPrevented).toBe(false);
    expect(progress()).toEqual(before);
  });

  it('keeps Escape and decision keys owned by the modal picker', async () => {
    await mount('/compendium/review?view=entries');
    await click('Pick other');
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    const before = progress();
    await key('a', window);
    await key('s', window);
    expect(progress()).toEqual(before);
    await key('Escape', window);
    expect(document.querySelector('dialog[open]')).toBeNull();
  });

  it('native save-dialog typing, Tab and Escape stay owned; the popover closes first', async () => {
    await mount();
    await click('Accept proposed');
    await openDrafts();
    const reviewButton = document.querySelector<HTMLButtonElement>('[data-drafts-review]')!;
    reviewButton.focus();
    await act(async () => reviewButton.click());
    // The popover is gone before the native dialog takes over.
    expect(overlay()).toBeNull();
    const dialog = host.ownerDocument.querySelector<HTMLDialogElement>(
      'dialog[aria-label="Review save"]',
    )!;
    expect(dialog.open).toBe(true);
    const beforeDrafts = structuredClone(useDraftStore.getState().drafts);
    const beforeProgress = localStorage.getItem(storageKey);
    const beforeRoute = route().href;
    const save = button('Save changes', dialog);
    save.focus();
    for (const shortcut of ['a', 's', 'n', 'p', 'u']) await key(shortcut, save);
    expect((await key('Tab', save)).defaultPrevented).toBe(false);
    dialog.querySelector('details')!.open = true;
    const input = dialog.querySelector('textarea')!;
    input.focus();
    await key('s', input);
    expect((await key('Escape', input)).defaultPrevented).toBe(false);
    expect(useDraftStore.getState().drafts).toEqual(beforeDrafts);
    expect(localStorage.getItem(storageKey)).toBe(beforeProgress);
    expect(route().href).toBe(beforeRoute);
    expect(captured.save).not.toHaveBeenCalled();
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(document.querySelector('dialog')).toBeNull();
    // Focus lands on the stable Drafts button in the header.
    expect(document.activeElement).toBe(draftsButton());
    expect(useSaveState.getState().locked).toBe(false);
    await key('s', window);
    expect(selected()).toBe('Sample 102');
    expect(progress().decisions[101].kind).toBe('skipped');
  });
});

it('keeps current unsaved English visible when matching evidence was prepared before text edits', async () => {
  const prepared = displayMatches(
    fixture.editor,
    fixture.source,
    {},
    emptyProgress(),
    undefined,
    fixture.document.scope,
    fixture.proposals,
    fixture.document,
  );
  const base = fixture.categories[0].entries.find((entry) => entry.hash === 100)!.base;
  const next = {
    ...base,
    text: { ...base.text, en: { ...base.text.en!, text: 'Current unsaved English' } },
  };
  useDraftStore.setState({ drafts: { 100: { base, next } } });
  await mount(undefined, undefined, prepared);
  expect(host.querySelector('[aria-label="Entry to review"] pre')?.textContent).toBe(
    'Current unsaved English',
  );
  await act(async () =>
    useDraftStore.setState({
      drafts: {
        100: {
          base,
          next: {
            ...next,
            text: { ...next.text, en: { ...next.text.en, text: 'Newer unsaved English' } },
          },
        },
      },
    }),
  );
  expect(host.querySelector('[aria-label="Entry to review"] pre')?.textContent).toBe(
    'Newer unsaved English',
  );
});
