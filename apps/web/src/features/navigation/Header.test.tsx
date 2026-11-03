// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { SaveController } from '../../services/save/SavePanel';
import { useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import type { User } from '../../services/api';
import type { CompendiumCount } from '../compendium/CompendiumBadge';
import { CompendiumBadge } from '../compendium/CompendiumBadge';
import { Header } from './Header';
import { PreviewLeaveGuard } from './PreviewLeaveGuard';

const mocks = vi.hoisted(() => ({ count: { state: 'ready', count: 0 } as CompendiumCount }));
vi.mock('../compendium/CompendiumBadge', async (original) => ({
  ...(await original<typeof import('../compendium/CompendiumBadge')>()),
  useCompendiumCount: () => mocks.count,
}));
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
  loginUrl: () => 'https://api.test/login',
  subscribeSession: () => () => {},
}));

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
});
const data = {
  categories: [{ id: 'c', label: 'Things', group: 'G', order: 1 }],
  items: {
    1: { hash: 1, name: 'First thing', icon: '', categoryId: 'c', inGameDescription: '' },
    2: { hash: 2, name: 'Second thing', icon: '', categoryId: 'c', inGameDescription: '' },
    9: { hash: 9, name: 'Old name', icon: '', categoryId: 'c', inGameDescription: '' },
  },
  aliases: { 9: { to: 1, kind: 'frame' } },
  bundle: {
    sourceCommit: 'abcdef123456',
    generatedAt: '2026-11-01T00:00:00Z',
    tooltips: { 1: tooltip(1, 'a'), 2: tooltip(2, 'b') },
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;
const person = (role: User['role'], extra = {}) =>
  ({ id: 7, login: 'pat', role, languages: ['de'], ...extra }) as unknown as User;

let host: HTMLDivElement;
let root: Root;
const originalAuth = useAuthStore.getState();
const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();

function Echo() {
  const location = useLocation();
  return <output data-route="">{`${location.pathname}${location.search}`}</output>;
}
function Shell({ user }: { user: User | null }) {
  return (
    <>
      <Header user={user} pathname={useLocation().pathname} routeFor={(to) => to} finder={null} />
      <PreviewLeaveGuard />
      <SaveController />
      <Echo />
    </>
  );
}
async function mount(user: User | null, path = '/') {
  useAuthStore.setState({ user, loading: false, load: async () => {} });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<Shell user={user} />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const click = (element: Element | null) => act(async () => void (element as HTMLElement).click());
async function key(target: Element, name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  await act(async () => void target.dispatchEvent(event));
  return event;
}
const route = () => q('[data-route]').textContent;
const tabNames = () =>
  [
    ...document.querySelectorAll(
      'nav[aria-label="Workspaces"] > ul > li > a, nav[aria-label="Workspaces"] > ul > li > button',
    ),
  ].map((element) => element.firstChild?.textContent);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  mocks.count = { state: 'ready', count: 0 };
  useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    pending: 0,
    error: null,
    generation: 1,
    hydrate: async () => {},
    activate: async () => {},
    flush: async () => {},
  });
  useSaveState.setState({ locked: false, review: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
  useAuthStore.setState(originalAuth);
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useSaveState.setState({ locked: false, review: null });
  vi.unstubAllGlobals();
});

describe('workspace tabs and More', () => {
  it('lists the role’s tabs, marks the current page, and keeps secondary pages in More', async () => {
    await mount(person('maintainer'), '/review');
    expect(tabNames()).toEqual(['Editor', 'Review changes', 'Compendium', 'Translations', 'More']);
    expect(q('a[aria-current="page"]').textContent).toBe('Review changes');
    expect(q('nav[aria-label="Workspaces"] button').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a menu of the secondary pages with roving arrow keys; Escape returns focus to More', async () => {
    await mount(person('maintainer'));
    const more = q('nav[aria-label="Workspaces"] button');
    await click(more);
    const menu = q('[role="menu"]');
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      'Bungie drift',
      'Lost text',
      'Archive',
      'Administration',
    ]);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(items[0]);
    await key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await key(items[1], 'ArrowUp');
    await key(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(items[3]);
    await key(items[3], 'Home');
    expect(document.activeElement).toBe(items[0]);
    await key(items[0], 'End');
    expect(document.activeElement).toBe(items[3]);
    await key(items[3], 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('follows a More item and closes the menu', async () => {
    await mount(person('editor'));
    await click(q('nav[aria-label="Workspaces"] button'));
    await click(q('[role="menuitem"][href="/archive"]'));
    expect(route()).toBe('/archive');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Archive lives in More, so More is the current tab.
    expect(q('nav[aria-label="Workspaces"] button').getAttribute('aria-current')).toBe('page');
  });

  it('shows no Administration to editors', async () => {
    await mount(person('editor'));
    await click(q('nav[aria-label="Workspaces"] button'));
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(['Bungie drift', 'Lost text', 'Archive']);
  });

  it('folds Translations into More on laptop widths', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 1280px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await mount(person('maintainer'));
    expect(tabNames()).toEqual(['Editor', 'Review changes', 'Compendium', 'More']);
    await click(q('nav[aria-label="Workspaces"] button'));
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(['Translations', 'Bungie drift', 'Lost text', 'Archive', 'Administration']);
  });

  it('keeps Translations as a tab for roles without a More menu', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 1280px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await mount(person('translator'));
    expect(tabNames()).toEqual(['Editor', 'Translations']);
  });
});

describe('Compendium count', () => {
  const badge = async (count: CompendiumCount) => {
    mocks.count = count;
    await mount(person('maintainer'));
    return q('nav[aria-label="Workspaces"] a[href="/compendium"]');
  };
  it('shows a count only above zero', async () => {
    expect((await badge({ state: 'ready', count: 0 })).querySelector('[role="img"]')).toBeNull();
    const link = await badge({ state: 'ready', count: 12 });
    expect(link.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '12 Compendium changes',
    );
    expect(link.textContent).toBe('Compendium12');
  });
  it('announces loading and error states accessibly', async () => {
    const loading = await badge({ state: 'loading' });
    expect(loading.querySelector('.sr-only')?.textContent).toBe('Compendium changes loading');
    const failed = await badge({ state: 'error' });
    expect(failed.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Compendium unavailable',
    );
  });
  it('renders nothing for zero on its own', async () => {
    await act(async () =>
      root.render(<CompendiumBadge count={{ state: 'ready', count: 0 }} className="x" />),
    );
    expect(host.innerHTML).toBe('');
  });
});

describe('drafts', () => {
  const draftFor = (hash: number, text: string) => ({
    base: tooltip(hash, 'old'),
    next: tooltip(hash, text),
  });

  it('counts local drafts on the button, with an accessible name', async () => {
    useDraftStore.setState({ drafts: { 1: draftFor(1, 'new'), 2: draftFor(2, 'newer') } });
    await mount(person('editor'));
    const button = q('[data-drafts-button]');
    expect(button.getAttribute('aria-label')).toBe('Drafts: 2 local drafts');
    expect(button.textContent).toBe('Drafts2');
  });

  it('lists each draft with its tooltip and language, and opens it from the popover', async () => {
    useDraftStore.setState({ drafts: { 1: draftFor(1, 'new'), 2: draftFor(2, 'newer') } });
    await mount(person('editor'));
    await click(q('[data-drafts-button]'));
    const rows = [...document.querySelectorAll('[aria-label="Local drafts"] li')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('First thing'),
      expect.stringContaining('Second thing'),
    ]);
    expect(rows[0].textContent).toContain('English');
    await click(rows[1].querySelector('button'));
    expect(route()).toBe('/t/2');
    // The popover closed before the navigation; focus is back on the header button.
    expect(document.querySelector('[data-shell-overlay]')).toBeNull();
  });

  it('discards only after confirmation; with drafts left the popover stays, with none it closes onto the button', async () => {
    vi.useFakeTimers();
    try {
      useDraftStore.setState({ drafts: { 1: draftFor(1, 'new'), 2: draftFor(2, 'newer') } });
      await mount(person('editor'));
      await click(q('[data-drafts-button]'));
      const discard = (name: string) => q(`button[aria-label="Discard draft ${name}"]`);
      await click(discard('First thing'));
      expect(q('dialog[open]').textContent).toContain('Discard the local draft of First thing?');
      await click(
        [...q('dialog[open]').querySelectorAll('button')].find(
          (b) => b.textContent === 'Keep draft',
        )!,
      );
      expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['1', '2']);

      await click(discard('First thing'));
      await click(
        [...q('dialog[open]').querySelectorAll('button')].find(
          (b) => b.textContent === 'Discard draft',
        )!,
      );
      await act(async () => void vi.advanceTimersByTime(5));
      expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['2']);
      expect(document.querySelector('[data-shell-overlay]')).not.toBeNull();

      await click(discard('Second thing'));
      await click(
        [...q('dialog[open]').querySelectorAll('button')].find(
          (b) => b.textContent === 'Discard draft',
        )!,
      );
      await act(async () => void vi.advanceTimersByTime(5));
      expect(useDraftStore.getState().drafts).toEqual({});
      expect(document.querySelector('[data-shell-overlay]')).toBeNull();
      expect(document.activeElement).toBe(q('[data-drafts-button]'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a recovered stale-alias draft visible, flags the button, and never deletes it by itself', async () => {
    useDraftStore.setState({ drafts: { 9: draftFor(9, 'Recovered work to keep') } });
    await mount(person('editor'));
    expect(q('[data-drafts-button]').getAttribute('aria-label')).toContain('needs attention');
    await click(q('[data-drafts-button]'));
    expect(q('[data-shell-overlay]').textContent).toContain(
      'Recovered draft conflict: 9 now shares tooltip 1',
    );
    expect(q('[data-shell-overlay]').textContent).toContain('Recovered work to keep');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['9']);
    const open = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Open shared tooltip'),
    )!;
    await click(open);
    expect(route()).toBe('/t/1');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['9']);
  });

  it('closing the popover keeps the save session: its dialog, submitted snapshot and result survive', async () => {
    useAuthStore.setState({ user: person('editor') });
    useDraftStore.setState({ drafts: { 1: draftFor(1, 'new') } });
    await mount(person('editor'));
    await click(q('[data-drafts-button]'));
    await click(q('[data-drafts-review]'));
    // The popover closes first; the review dialog belongs to the controller.
    expect(document.querySelector('[data-shell-overlay]')).toBeNull();
    expect(q('dialog[open]').getAttribute('aria-label')).toBe('Review save');
    expect(useSaveState.getState().review?.submitted).toEqual({ 1: draftFor(1, 'new') });
    // Opening and closing the popover again does not unmount the review.
    await act(
      async () => void q('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })),
    );
    expect(useSaveState.getState().review).toBeNull();
    await click(q('[data-drafts-button]'));
    await key(document.activeElement!, 'Escape');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['1']);
  });
});

describe('identity menu', () => {
  const open = async () => click(q('[data-identity-button]'));
  const text = () => q('[data-shell-overlay]').textContent ?? '';

  it('shows who is signed in with the role, the revision, Settings and Sign out', async () => {
    await mount(person('maintainer'));
    expect(q('[data-identity-button]').textContent).toBe('patmaintainer');
    await open();
    expect(text()).toMatch(/^pat\s*maintainer/);
    expect(text()).toContain('Data revision abcdef12');
    expect(
      [...document.querySelectorAll('[data-shell-overlay] button')].map((b) => b.textContent),
    ).toEqual(['Settings', 'Sign out']);
  });

  it('explains read-only accounts and translator languages', async () => {
    await mount(person(null));
    await open();
    expect(text()).toContain('Read-only: ask a maintainer for an editing role.');
    await key(document.activeElement!, 'Escape');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(person('translator', { languages: ['de', 'fr'] }));
    await open();
    expect(text()).toContain('Editable languages: German, French.');
  });

  it('offers sign-in with the remember choice when signed out', async () => {
    await mount(null);
    expect(q('[data-identity-button]').textContent).toBe('Sign in');
    await open();
    expect(text()).toContain('Read-only: sign in to edit.');
    const link = q<HTMLAnchorElement>('[data-shell-overlay] a');
    expect(link.href).toBe('https://api.test/login');
    expect(q('[data-shell-overlay] input[type="checkbox"]')).not.toBeNull();
  });

  it('shows login problems with a retry, and the loading moment', async () => {
    const load = vi.fn(async () => {});
    await mount(null);
    useAuthStore.setState({ error: 'Network down', loading: false, load });
    await act(async () => {});
    expect(q('[data-identity-button]').getAttribute('data-tone')).toBe('error');
    await open();
    expect(text()).toContain('Login unavailable: Network down');
    await click(
      [...document.querySelectorAll('[data-shell-overlay] button')].find(
        (b) => b.textContent === 'Retry login status',
      )!,
    );
    expect(load).toHaveBeenCalled();
    useAuthStore.setState({ error: null, loading: true });
    await act(async () => {});
    expect(q('[data-identity-button]').getAttribute('data-tone')).toBe('wait');
    expect(text()).toContain('Checking login…');
  });

  it('puts a data load failure with its retry in the menu, and keeps the revision line', async () => {
    const load = vi.fn(async () => {});
    useDataStore.setState({ data: null, error: 'Offline', load });
    await mount(person('editor'));
    await open();
    expect(text()).toContain('Cannot load editor data: Offline');
    expect(text()).toContain('Data not loaded');
    await click(
      [...document.querySelectorAll('[data-shell-overlay] button')].find(
        (b) => b.textContent === 'Retry data loading',
      )!,
    );
    expect(load).toHaveBeenCalled();
  });
});
