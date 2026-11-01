// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from '../tooltip/TooltipPage';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

vi.mock('../../services/save/SavePanel', () => ({ SavePanel: () => null }));
vi.mock('../auth/AuthStatus', () => ({ AuthStatus: () => null }));
vi.mock('../compendium/CompendiumBadge', () => ({ CompendiumBadge: () => null }));
vi.mock('../editor', () => ({ ClarityEditor: () => null }));
vi.mock('../preview', () => ({ TooltipPreview: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));
vi.mock('../tooltip/VariantWorkspace', () => ({
  VariantWorkspace: ({ editor }: { editor: ReactNode }) => editor,
}));

function tooltip(hash: number): Tooltip {
  return {
    hash,
    text: {
      en: { text: `English ${hash}`, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' },
      de: { text: `Deutsch ${hash}`, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' },
    },
    associated: [],
  };
}

const data: EditorData = {
  categories: [{ id: 'samples', label: 'Samples', group: 'Test', order: 1 }],
  items: {
    100: { hash: 100, name: 'Sample 100', icon: '', categoryId: 'samples', inGameDescription: '' },
    101: { hash: 101, name: 'Sample 101', icon: '', categoryId: 'samples', inGameDescription: '' },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-11-01T00:00:00Z',
    tooltips: { 1: tooltip(1), 2: tooltip(2), 3: tooltip(3), 100: tooltip(100), 101: tooltip(101) },
    permissions: { users: {} },
    pushed: {},
  },
};

const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
let host: HTMLDivElement;
let root: Root | undefined;
let navigate: ReturnType<typeof useNavigate>;

function RouteState() {
  const location = useLocation();
  navigate = useNavigate();
  return createElement('output', { 'data-route': '' }, `${location.pathname}${location.search}`);
}

function route() {
  return host.querySelector('[data-route]')?.textContent;
}

function selectedItem() {
  return host.querySelector('article > header h1')?.textContent;
}

async function mount() {
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/t/100?lang=de'] },
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
              createElement(Route, { path: '/t/:hash', element: createElement(TooltipPage) }),
            ),
          ),
        ),
      ),
    );
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function shiftWheel() {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    deltaY: 100,
  });
  await act(async () => host.dispatchEvent(event));
  return event;
}

function browseButton() {
  const button = host.querySelector<HTMLButtonElement>('[aria-controls="sidebar"]');
  if (!button) throw new Error('Browse toggle is missing');
  return button;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    pending: 0,
    error: null,
    hydrate: async () => {},
  });
  useAuthStore.setState({ user: null, loading: false });
  document.body.style.overflow = '';
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.remove());
  host.remove();
  document.body.style.overflow = '';
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  vi.restoreAllMocks();
});

describe('mounted Editor navigation interaction ownership', () => {
  it('suspends Shift+wheel while Browse owns interaction and resumes after Close', async () => {
    await mount();
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');

    await click(browseButton());
    const close = browseButton();
    expect(close.textContent).toBe('Close');
    expect(document.activeElement).toBe(close);

    const whileOpen = await shiftWheel();
    expect(whileOpen.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');
    expect(host.querySelector('#sidebar')?.getAttribute('data-open')).toBe('true');

    await click(close);
    expect(document.activeElement).toBe(browseButton());
    const afterClose = await shiftWheel();
    expect(afterClose.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/101?lang=de');
    expect(selectedItem()).toBe('Sample 101');
  });

  it('suspends Shift+wheel while a native dialog owns interaction and resumes after close', async () => {
    await mount();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);

    const whileOpen = await shiftWheel();
    expect(whileOpen.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');

    dialog.removeAttribute('open');
    const afterClose = await shiftWheel();
    expect(afterClose.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/101?lang=de');
    expect(selectedItem()).toBe('Sample 101');
  });

  it.each([
    { main: false, skip: false, closeWith: 'Close' },
    { main: false, skip: true, closeWith: 'Escape' },
    { main: true, skip: false, closeWith: 'Close' },
    { main: true, skip: true, closeWith: 'Escape' },
  ])(
    'restores each prior inert state and body overflow after $closeWith',
    async ({ main: mainInert, skip: skipInert, closeWith }) => {
      await mount();
      const main = host.querySelector<HTMLElement>('#main-content')!;
      const skip = host.querySelector<HTMLElement>('a[href="#main-content"]')!;
      if (mainInert) main.setAttribute('inert', 'main-before');
      if (skipInert) skip.setAttribute('inert', 'skip-before');
      document.body.style.overflow = 'clip';

      await click(browseButton());
      expect(main.hasAttribute('inert')).toBe(true);
      expect(skip.hasAttribute('inert')).toBe(true);
      expect(document.body.style.overflow).toBe('hidden');

      if (closeWith === 'Escape') {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
      } else {
        await click(browseButton());
      }

      expect(main.getAttribute('inert')).toBe(mainInert ? 'main-before' : null);
      expect(skip.getAttribute('inert')).toBe(skipInert ? 'skip-before' : null);
      expect(document.body.style.overflow).toBe('clip');
    },
  );

  it.each(['navigation', 'unmount'])(
    'restores inert and overflow during %s cleanup',
    async (cleanup) => {
      await mount();
      const main = host.querySelector<HTMLElement>('#main-content')!;
      const skip = host.querySelector<HTMLElement>('a[href="#main-content"]')!;
      skip.setAttribute('inert', '');
      document.body.style.overflow = 'auto';
      await click(browseButton());

      if (cleanup === 'navigation') {
        await act(async () => navigate('/t/101?lang=de'));
      } else {
        await act(async () => root?.unmount());
        root = undefined;
      }

      expect(main.hasAttribute('inert')).toBe(false);
      expect(skip.getAttribute('inert')).toBe('');
      expect(document.body.style.overflow).toBe('auto');
    },
  );
});
