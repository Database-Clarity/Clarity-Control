// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Layout } from './Layout';
import styles from './Layout.module.scss';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSidebarQueueStore } from './sidebarQueue';

vi.mock('../../services/save/SavePanel', () => ({ SavePanel: () => null }));
vi.mock('../auth/AuthStatus', () => ({ AuthStatus: () => createElement('p', null, 'Signed in') }));
vi.mock('../compendium/CompendiumBadge', () => ({ CompendiumBadge: () => null }));
vi.mock('./TooltipNavigation', () => ({
  TooltipNavigation: () =>
    createElement(
      'div',
      null,
      createElement('section', { 'aria-label': 'Tooltip navigation' }, 'Tooltip list'),
      createElement('div', { role: 'group', 'aria-label': 'Step within category' }, 'Previous'),
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

function workspaceSelect() {
  const select = host.querySelector<HTMLSelectElement>(`.${styles.pageSelection} select`);
  if (!select) throw new Error('Workspace selector is missing');
  return select;
}

async function chooseWorkspace(path: string) {
  await act(async () => {
    const select = workspaceSelect();
    select.value = path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
  useDataStore.setState({ data: null, status: 'idle', error: null });
  useDraftStore.setState({ drafts: {}, hydrated: false, pending: 0, error: null });
  useSidebarQueueStore.setState({ compendiumCategories: null, pendingChanges: null });
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

describe('context-aware sidebar navigation', () => {
  it('switches sidebar bodies by workspace without showing Editor controls elsewhere', async () => {
    await mount('/t/10');
    expect(host.querySelector('[aria-label="Tooltip navigation"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Step within category"]')).not.toBeNull();

    await chooseWorkspace('/compendium');
    expect(host.querySelector('[aria-label="Tooltip navigation"]')).toBeNull();
    expect(host.querySelector('[aria-label="Step within category"]')).toBeNull();
    expect(host.querySelector('[aria-label="Compendium category queue"]')).not.toBeNull();
    await click(host.querySelector('[aria-label="Compendium category queue"] a')!);
    expect(location()).toBe('/compendium/review?view=entries&group=catalog%3Aarmor');

    await chooseWorkspace('/review');
    expect(host.querySelector('[aria-label="Compendium category queue"]')).toBeNull();
    expect(host.querySelector('[aria-label="Pending saved changes"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Step within category"]')).toBeNull();
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

  it('opens Browse as a bounded modal, traps focus, and restores selection on Escape', async () => {
    await mount('/compendium/review?view=entries&group=catalog%3Aarmor&hash=42');
    const browse = host.querySelector<HTMLButtonElement>('[aria-controls="sidebar"]');
    const main = host.querySelector<HTMLElement>('#main-content');
    const sidebar = host.querySelector<HTMLElement>('#sidebar');
    expect(browse).not.toBeNull();
    expect(main).not.toBeNull();
    expect(sidebar).not.toBeNull();
    expect(sidebar?.querySelector('[aria-label="Step within category"]')).toBeNull();

    await click(browse!);
    expect(sidebar?.getAttribute('role')).toBe('dialog');
    expect(sidebar?.getAttribute('aria-modal')).toBe('true');
    expect(browse?.textContent).toBe('Close');
    expect(document.activeElement).toBe(browse);
    expect(main?.hasAttribute('inert')).toBe(true);
    expect(main?.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    const select = workspaceSelect();
    select.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(browse);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(sidebar?.getAttribute('role')).toBeNull();
    expect(browse?.textContent).toBe('Browse');
    expect(document.activeElement).toBe(browse);
    expect(main?.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(location()).toBe('/compendium/review?view=entries&group=catalog%3Aarmor&hash=42');
    expect(
      host.querySelector('[aria-label="Compendium category queue"] a[aria-current="page"]'),
    ).not.toBeNull();
  });

  it('bounds the drawer to the viewport and keeps one scroll body with the close control outside it', async () => {
    await mount('/review');
    await click(host.querySelector<HTMLButtonElement>('[aria-controls="sidebar"]')!);
    const sidebar = host.querySelector<HTMLElement>('#sidebar')!;
    const body = sidebar.querySelector<HTMLElement>(`.${styles.sidebarBody}`)!;
    const close = sidebar.querySelector<HTMLButtonElement>('[aria-controls="sidebar"]')!;
    expect(close.parentElement).toBe(sidebar);
    expect(body.contains(close)).toBe(false);
    expect(body.querySelectorAll('.sidebarBody')).toHaveLength(0);

    const css = readFileSync('apps/web/src/features/navigation/Layout.module.scss', 'utf8');
    expect(css).toMatch(/height:\s*100dvh/);
    expect(css).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
