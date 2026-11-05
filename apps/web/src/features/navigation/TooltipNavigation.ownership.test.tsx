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
import { useSteppingActivity } from './steppingActivity';

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
vi.mock('../editor', () => ({ ClarityEditor: () => null }));
vi.mock('../preview', () => ({
  PreviewColumn: ({ baseText }: { baseText: string }) =>
    createElement('div', { 'data-preview': '' }, baseText),
  TooltipPreview: () => null,
}));
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
  return host.querySelector('article > h1')?.textContent;
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  return event;
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
    activate: async () => {},
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
  it.each(['ArrowDown', 'Shift+wheel'])(
    'keeps stepping active and the document visible while %s continues at the category boundary',
    async (gesture) => {
      vi.useFakeTimers();
      try {
        await mount();
        const field = host.querySelector<HTMLInputElement>('input[aria-label="Tooltip"]')!;
        const down = () =>
          gesture === 'ArrowDown'
            ? field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
            : host.dispatchEvent(
                new WheelEvent('wheel', {
                  bubbles: true,
                  cancelable: true,
                  shiftKey: true,
                  deltaY: 100,
                }),
              );
        await act(async () => {
          down();
          await vi.advanceTimersByTimeAsync(25);
        });
        expect(route()).toContain('/t/101');
        expect(useSteppingActivity.getState().active).toBe(true);
        expect(document.querySelector('[data-preview]')?.textContent).toBe('Deutsch 101');
        if (gesture === 'ArrowDown') {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
          });
          expect(useSteppingActivity.getState().active).toBe(true);
          expect(document.querySelector('[data-preview]')?.textContent).toBe('Deutsch 101');
        }
        await act(async () => {
          down();
          await vi.advanceTimersByTimeAsync(25);
        });
        expect(useSteppingActivity.getState().active).toBe(true);
        expect(document.querySelector('[data-preview]')?.textContent).toBe('Deutsch 101');
        await act(async () => {
          if (gesture === 'ArrowDown')
            field.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(useSteppingActivity.getState().active).toBe(false);
        expect(document.querySelector('[data-preview]')?.textContent).toBe('Deutsch 101');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not land a queued wheel step behind a newly opened sheet', async () => {
    await mount();
    await act(async () => {
      host.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: 100 }),
      );
      draftsButton().click();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(overlay()).not.toBeNull();
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');
  });
  it('restores the settled preview into the same shell slot after stepping', async () => {
    await mount();
    expect(host.querySelector('[data-shell-slot="left"] [data-preview]')?.textContent).toBe(
      'Deutsch 100',
    );
    await shiftWheel();
    expect(route()).toBe('/t/101?lang=de');
    expect(host.querySelector('[data-shell-slot="left"] [data-preview]')?.textContent).toBe(
      'Deutsch 101',
    );
  });
  const draftsButton = () => host.querySelector<HTMLButtonElement>('[data-drafts-button]')!;
  const overlay = () => document.querySelector('[data-shell-overlay]');
  const escape = () =>
    act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });

  it('suspends Shift+wheel while a shell overlay owns interaction and resumes after Escape', async () => {
    await mount();
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');

    await click(draftsButton());
    expect(overlay()).not.toBeNull();
    expect(draftsButton().getAttribute('aria-expanded')).toBe('true');

    const whileOpen = await shiftWheel();
    expect(whileOpen.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');

    await escape();
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(draftsButton());
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

  it('suspends Shift+wheel while the finder list is open, and the wheel scrolls the list', async () => {
    await mount();
    const field = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await click(field);
    expect(field.getAttribute('aria-expanded')).toBe('true');
    const whileOpen = await shiftWheel();
    expect(whileOpen.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/100?lang=de');
    // Escape restores the current item and closes the list, keeping focus in the field.
    field.focus();
    await escape();
    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Sample 100');
  });

  describe.each([
    { shape: 'popover', phone: false },
    { shape: 'sheet', phone: true },
  ])('$shape', ({ phone }) => {
    beforeEach(() => {
      if (phone) {
        vi.stubGlobal('matchMedia', (query: string) => ({
          matches: query.includes('max-width: 700px'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }));
      }
    });
    afterEach(() => vi.unstubAllGlobals());
    const opener = () =>
      phone
        ? host.querySelector<HTMLButtonElement>('header button[aria-label^="Drafts"]')!
        : draftsButton();

    it.each([
      { shell: false, owner: false },
      { shell: false, owner: true },
      { shell: true, owner: false },
      { shell: true, owner: true },
    ])(
      'restores each prior inert state and body overflow (inert before=$shell, overflow before=$owner)',
      async ({ shell, owner }) => {
        await mount();
        const shellRoot = host.querySelector<HTMLElement>('#shell-root')!;
        if (shell) shellRoot.setAttribute('inert', 'before');
        document.body.style.overflow = owner ? 'clip' : '';

        await click(opener());
        expect(shellRoot.hasAttribute('inert')).toBe(true);
        expect(document.body.style.overflow).toBe(phone ? 'hidden' : owner ? 'clip' : '');

        await escape();
        expect(shellRoot.getAttribute('inert')).toBe(shell ? 'before' : null);
        expect(document.body.style.overflow).toBe(owner ? 'clip' : '');
      },
    );

    it.each(['navigation', 'unmount'])(
      'restores inert and overflow during %s cleanup',
      async (cleanup) => {
        await mount();
        const shellRoot = host.querySelector<HTMLElement>('#shell-root')!;
        document.body.style.overflow = 'auto';
        await click(opener());
        expect(shellRoot.hasAttribute('inert')).toBe(true);

        if (cleanup === 'navigation') {
          await act(async () => navigate('/t/101?lang=de'));
          expect(overlay()).toBeNull();
        } else {
          await act(async () => root?.unmount());
          root = undefined;
        }

        expect(shellRoot.hasAttribute('inert')).toBe(false);
        expect(document.body.style.overflow).toBe('auto');
      },
    );
  });
});
