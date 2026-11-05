// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSidebarQueueStore } from './sidebarQueue';
import { CompendiumSidebarNavigation } from './SidebarNavigation';

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
vi.mock('./TooltipNavigation', () => ({
  TooltipNavigation: () =>
    createElement(
      'div',
      null,
      createElement('section', { 'aria-label': 'Tooltip navigation' }, 'Tooltip list'),
    ),
}));

const editorData = { bundle: { sourceCommit: 'fixture' } } as unknown as EditorData;
let host: HTMLDivElement;
let root: Root;

function RouteContent() {
  const location = useLocation();
  return createElement(
    'output',
    { 'data-testid': 'location' },
    `${location.pathname}${location.search}`,
  );
}

async function mount(path: string) {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Layout) },
            createElement(Route, { path: '*', element: createElement(RouteContent) }),
          ),
        ),
      ),
    );
  });
}

function location() {
  return host.querySelector('[data-testid="location"]')?.textContent;
}

async function chooseWorkspace(path: string) {
  await act(async () => {
    const link = host.querySelector<HTMLAnchorElement>(
      `nav[aria-label="Workspaces"] a[href^="${path}"]`,
    );
    if (!link) throw new Error(`Workspace tab ${path} is missing`);
    link.click();
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useAuthStore.setState({
    user: { id: 1, login: 'fixture', role: 'maintainer' },
    loading: false,
    load: async () => {},
  });
  useDataStore.setState({
    data: editorData,
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
  useSidebarQueueStore.setState({
    compendiumCategories: [
      { id: 'catalog:armor', name: 'Armor category with a deliberately long name'.repeat(3) },
      { id: 'catalog:weapons', name: 'Weapons' },
    ],
    pendingChanges: [
      { hash: 42, name: 'Pending tooltip 42', category: 'Armor' },
      { hash: 43, name: 'Pending tooltip 43', category: 'Weapons' },
    ],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState({ user: null, loading: false });
  useDataStore.setState({ data: null, status: 'idle', error: null });
  useDraftStore.setState({ drafts: {}, hydrated: false, pending: 0, error: null });
  useSidebarQueueStore.setState({ compendiumCategories: null, pendingChanges: null });
  document.body.style.overflow = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('context-aware navigation', () => {
  it('keeps native Compendium category hrefs inside the router basename', async () => {
    const router = createMemoryRouter(
      [{ path: '*', element: createElement(CompendiumSidebarNavigation) }],
      { basename: '/workspace', initialEntries: ['/workspace/compendium/review'] },
    );
    await act(async () => root.render(createElement(RouterProvider, { router })));
    const link = host.querySelector<HTMLAnchorElement>('li a')!;
    expect(link.getAttribute('href')).toBe(
      '/workspace/compendium/review?view=entries&group=catalog%3Aarmor',
    );
    await click(link);
    expect(router.state.location.pathname).toBe('/workspace/compendium/review');
    expect(router.state.location.search).toBe('?view=entries&group=catalog%3Aarmor');
  });

  it('commits a Compendium link immediately, while retaining modified clicks and history', async () => {
    const start = '/compendium/review';
    const target = '/compendium/review?view=entries&group=catalog%3Aweapons';
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: createElement(
            'div',
            null,
            createElement(CompendiumSidebarNavigation),
            createElement(RouteContent),
          ),
        },
      ],
      { initialEntries: [start] },
    );
    await act(async () => root.render(createElement(RouterProvider, { router })));
    const link = host.querySelector<HTMLAnchorElement>(`a[href="${target}"]`)!;
    expect(link).not.toBeNull();
    // Suppress jsdom's native navigation after checking that React leaves the
    // modified click to the browser, with the original native href intact.
    let intercepted: boolean | undefined;
    host.addEventListener(
      'click',
      (event) => {
        intercepted = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    await act(async () => {
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      );
    });
    expect(intercepted).toBe(false);
    expect(location()).toBe(start);
    await act(async () => {
      link.click();
      expect(location()).toBe(target);
    });
    await click(link);
    await act(async () => router.navigate(-1));
    expect(location()).toBe(start);
  });

  it('switches the context body by workspace without showing Editor controls elsewhere', async () => {
    await mount('/t/10');
    expect(host.querySelector('[aria-label="Tooltip navigation"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Context"]')).toBeNull();

    await chooseWorkspace('/compendium');
    expect(host.querySelector('[aria-label="Tooltip navigation"]')).toBeNull();
    expect(host.querySelector('[aria-label="Compendium category queue"]')).not.toBeNull();
    await click(host.querySelector('[aria-label="Compendium category queue"] a')!);
    expect(location()).toBe('/compendium/review?view=entries&group=catalog%3Aarmor');

    await chooseWorkspace('/review');
    expect(host.querySelector('[aria-label="Compendium category queue"]')).toBeNull();
    expect(host.querySelector('[aria-label="Pending saved changes"]')).not.toBeNull();
  });

  it('preserves the selected Compendium category and item in route history', async () => {
    await mount('/compendium/review?view=entries&group=catalog%3Aarmor&hash=42');
    expect(
      host.querySelector('[aria-label="Compendium category queue"] a[aria-current="page"]')
        ?.textContent,
    ).toContain('Armor category');
    await chooseWorkspace('/review');
    expect(host.querySelector('[aria-label="Pending saved changes"]')).not.toBeNull();
    await chooseWorkspace('/compendium');
    expect(location()).toBe('/compendium/review?view=entries&group=catalog%3Aarmor&hash=42');
    expect(
      host.querySelector('[aria-label="Compendium category queue"] a[aria-current="page"]'),
    ).not.toBeNull();
  });

  it('preserves the selected pending saved change in route history', async () => {
    await mount('/review?hash=42');
    expect(
      host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')
        ?.textContent,
    ).toContain('Pending tooltip 42');
    await click(
      host.querySelector('[aria-label="Pending saved changes"] a[href="/review?hash=43"]')!,
    );
    expect(location()).toBe('/review?hash=43');
    await chooseWorkspace('/compendium');
    await chooseWorkspace('/review');
    expect(location()).toBe('/review?hash=43');
    expect(
      host.querySelector('[aria-label="Pending saved changes"] a[aria-current="page"]')
        ?.textContent,
    ).toContain('Pending tooltip 43');
  });

  it('on the phone, opens the queue in the title sheet, closes it on Escape and restores focus', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 700px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await mount('/compendium/review?view=entries&group=catalog%3Aarmor&hash=42');
    // No desktop column on the phone: the queue lives in the finder sheet.
    expect(host.querySelector('aside[aria-label="Context"]')).toBeNull();
    const title = host.querySelector<HTMLButtonElement>(
      'header button[aria-haspopup="dialog"][aria-expanded]',
    )!;
    const titleButton = [...host.querySelectorAll<HTMLButtonElement>('header button')].find(
      (button) => button.textContent?.includes('Compendium'),
    )!;
    expect(title).not.toBeNull();
    expect(titleButton.getAttribute('aria-expanded')).toBe('false');

    await click(titleButton);
    const sheet = document.querySelector<HTMLElement>('[data-shell-overlay="Find"]');
    expect(sheet).not.toBeNull();
    expect(
      sheet!.querySelector('[aria-label="Compendium category queue"] a[aria-current="page"]'),
    ).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    expect(host.querySelector('#shell-root')?.hasAttribute('inert')).toBe(true);

    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector('[data-shell-overlay="Find"]')).toBeNull();
    expect(document.activeElement).toBe(titleButton);
    expect(document.body.style.overflow).toBe('');
    expect(host.querySelector('#shell-root')?.hasAttribute('inert')).toBe(false);
    expect(location()).toBe('/compendium/review?view=entries&group=catalog%3Aarmor&hash=42');
  });
});
