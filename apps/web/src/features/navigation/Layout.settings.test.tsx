// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsPanel } from '../settings/panel';

vi.hoisted(() => {
  // Node's own (flag-gated) localStorage shadows jsdom's; the settings store reads it at import.
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, String(value)),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
    },
  });
});
vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));
// The header prefetches this page during idle time. These settings tests never
// navigate there, and its module graph must not outlive their jsdom environment.
vi.mock('../compendium/CompendiumTab', () => ({ CompendiumTab: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useDataStore.setState({
    status: 'ready',
    data: {
      categories: [],
      items: {},
      aliases: {},
      bundle: {
        sourceCommit: 'fixture0',
        generatedAt: '2026-10-27T00:00:00Z',
        tooltips: {},
        permissions: { users: {} },
        pushed: {},
      },
    } as unknown as EditorData,
    load: async () => {},
  });
  useAuthStore.setState({ user: null, loading: false, load: async () => {} });
  useDraftStore.setState({
    hydrated: true,
    drafts: {},
    hydrate: async () => {},
    activate: async () => {},
  });
  useSettingsPanel.setState({ open: false, returnTo: '/' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('opens Settings from the identity menu, keeps Tab inside it, and gives focus back to the stable header button', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/archive']}>
        <Layout />
      </MemoryRouter>,
    ),
  );
  const click = (element: Element) => act(async () => (element as HTMLElement).click());
  const identity = host.querySelector<HTMLElement>('[data-identity-button]')!;
  await click(identity);
  const menu = document.querySelector('[data-shell-overlay="Account"]')!;
  expect(menu).not.toBeNull();
  const settings = [...menu.querySelectorAll('button')].find((b) => b.textContent === 'Settings')!;
  await click(settings);
  // The menu item that opened Settings is gone; the header button is the anchor and return target.
  expect(document.querySelector('[data-shell-overlay="Account"]')).toBeNull();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]')!;
  expect(dialog).not.toBeNull();
  const items = [...dialog.querySelectorAll<HTMLElement>('button, select')];
  items.at(-1)!.focus();
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).toBe(items[0]);
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  expect(document.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
  expect(document.activeElement).toBe(identity);
  expect(host.querySelector('#shell-root')?.hasAttribute('inert')).toBe(false);
});

it('closes the settings popover when Back changes the page behind it', async () => {
  let go: NavigateFunction | undefined;
  function Probe() {
    go = useNavigate();
    return null;
  }
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/archive', '/archive?x=1']} initialIndex={1}>
        <Probe />
        <Layout />
      </MemoryRouter>,
    ),
  );
  await act(async () => useSettingsPanel.getState().show());
  expect(document.querySelector('[role="dialog"][aria-labelledby]')).not.toBeNull();
  await act(async () => go!(-1));
  expect(useSettingsPanel.getState().open).toBe(false);
  expect(document.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
});

it('keeps read-only browsing when draft storage (IndexedDB) cannot be opened', async () => {
  useDraftStore.setState({
    hydrated: false,
    drafts: {},
    error: 'Cannot recover local drafts: blocked. Editing is disabled; browsing is read-only.',
  });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/archive']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/archive" element={<p>Archive content</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
  expect(host.textContent).toContain('Cannot recover local drafts');
  expect(host.textContent).toContain('Archive content');
});
