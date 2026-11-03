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
import { usePreviewReviewStore } from '../../stores/previewReview';
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
vi.mock('../editor', () => ({ ClarityEditor: () => <textarea aria-label="Editor" /> }));
vi.mock('../preview', () => ({
  PreviewColumn: ({ baseText }: { baseText: string }) => <div data-preview>{baseText}</div>,
}));
vi.mock('../compendium/CompendiumPanel', () => ({
  CompendiumPanel: () => <div data-compendium />,
}));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => <div data-history /> }));
vi.mock('../associations/AssociationsPanel', () => ({
  AssociationsPanel: () => <div data-associations />,
}));
vi.mock('../tooltip/VariantWorkspace', () => ({
  VariantWorkspace: ({
    editor,
    preview,
    compendium,
  }: {
    editor: ReactNode;
    preview: ReactNode;
    compendium: ReactNode;
  }) => (
    <div data-workspace>
      {editor}
      {preview}
      {compendium}
    </div>
  ),
}));

const tooltip = (hash: number, text = `English ${hash}`): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'x' } },
  associated: [],
});
const data = {
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
} as unknown as EditorData;
const draftOf = (text: string) => ({ 100: { base: tooltip(100), next: tooltip(100, text) } });

const originals = {
  data: useDataStore.getState(),
  drafts: useDraftStore.getState(),
  auth: useAuthStore.getState(),
};
let host: HTMLDivElement;
let root: Root;
let width = 1366;

async function mount(path = '/t/100') {
  const router = createMemoryRouter(
    [{ element: <Layout />, children: [{ path: '/t/:hash', element: <TooltipPage /> }] }],
    { initialEntries: [path] },
  );
  root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}
const aside = () => host.querySelector<HTMLElement>('#shell-left');
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-controls="shell-left"]')!;
const pressAltP = () =>
  act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        code: 'KeyP',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
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
  usePreviewReviewStore.setState({ scope: null, entries: {}, prompt: null, host: null });
  useSettingsStore.getState().setPane('editor:left', null);
  width = 1366;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as { matchMedia?: unknown }).matchMedia;
  useSettingsStore.getState().setPane('editor:left', null);
  useDataStore.setState(originals.data);
  useDraftStore.setState(originals.drafts);
  useAuthStore.setState(originals.auth);
  vi.unstubAllGlobals();
});

describe('the preview column', () => {
  it('holds the preview, associations and history once, leaving only the Compendium beside the editor', async () => {
    await mount();
    expect(aside()?.getAttribute('aria-label')).toBe('Preview');
    expect(aside()?.querySelectorAll('[data-preview]')).toHaveLength(1);
    expect(aside()?.querySelector('[data-associations]')).not.toBeNull();
    expect(aside()?.querySelector('[data-history]')).not.toBeNull();
    expect(host.querySelectorAll('[data-preview]')).toHaveLength(1);
    const main = host.querySelector('#main-content')!;
    expect(main.querySelector('[data-preview]')).toBeNull();
    expect(main.querySelector('[data-compendium]')).not.toBeNull();
    expect(main.querySelector('[data-history]')).toBeNull();
  });

  it('collapses and expands from the button and Alt+P, keeping its content mounted', async () => {
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle().click());
    expect(aside()?.hasAttribute('hidden')).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(aside()?.querySelector('[data-preview]')).not.toBeNull();
    await pressAltP();
    expect(aside()?.hasAttribute('hidden')).toBe(false);
    // Showing it moves focus into the column.
    expect(document.activeElement).toBe(aside());
    await pressAltP();
    expect(aside()?.hasAttribute('hidden')).toBe(true);
    expect(useSettingsStore.getState().device.panes['editor:left']?.collapsed).toBe(true);
  });

  it('moves focus out of the column before hiding it', async () => {
    await mount();
    act(() => aside()!.focus());
    await pressAltP();
    expect(document.activeElement).toBe(toggle());
  });

  it('ignores Alt+P while a dialog or sheet owns the keyboard', async () => {
    await mount();
    const sheet = document.createElement('div');
    sheet.setAttribute('data-shell-overlay', '');
    document.body.append(sheet);
    await pressAltP();
    sheet.remove();
    expect(aside()?.hasAttribute('hidden')).toBe(false);
  });

  it('records a change as unreviewed only while collapsed, and counts it on the column toggle (the editor status bar says it too)', async () => {
    await mount();
    // Expanded: the preview renders each edit, so nothing stays unreviewed.
    await act(async () => useDraftStore.setState({ drafts: draftOf('a') }));
    expect(usePreviewReviewStore.getState().unreviewed(100)).toEqual([]);
    await act(async () => toggle().click());
    await act(async () => useDraftStore.setState({ drafts: draftOf('ab') }));
    expect(usePreviewReviewStore.getState().unreviewed(100)).toEqual([100]);
    expect(toggle().getAttribute('aria-label')).toContain('1 change not reviewed');
    // Showing the preview clears it.
    await act(async () => usePreviewReviewStore.getState().host?.show());
    expect(usePreviewReviewStore.getState().unreviewed(100)).toEqual([]);
  });

  it('starts collapsed in compact windows without saving that as a choice', async () => {
    width = 1000;
    await mount();
    expect(aside()?.hasAttribute('hidden')).toBe(true);
    expect(useSettingsStore.getState().device.panes['editor:left']).toBeUndefined();
    await act(async () => toggle().click());
    expect(aside()?.hasAttribute('hidden')).toBe(false);
    expect(useSettingsStore.getState().device.panes['editor:left']).toBeUndefined();
  });

  it('has no column, divider or guard host on a phone: the preview stays a view of the page', async () => {
    width = 390;
    await mount();
    expect(aside()).toBeNull();
    expect(host.querySelector('[role="separator"]')).toBeNull();
    expect(usePreviewReviewStore.getState().host).toBeNull();
    expect(host.querySelectorAll('[data-preview]')).toHaveLength(1);
    expect(host.querySelector('#main-content [data-preview]')).not.toBeNull();
    expect(host.querySelector('#main-content [data-history]')).not.toBeNull();
  });
});
