// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from '../tooltip/TooltipPage';
import { TooltipPreview } from '../preview/TooltipPreview';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { publishSteppingTarget, settleStepping, useSteppingActivity } from './steppingActivity';
import type { ClarityEditorProps } from '../editor';
import { observeNativeDialogShortcutOwner, workspaceShortcutsBlocked } from '../../ui/interaction';

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
vi.mock('../editor', () => ({
  ClarityEditor: ({ value, tooltipHash, onChange }: ClarityEditorProps) =>
    createElement(
      'div',
      {
        className: 'cm-editor',
        'data-document-hash': tooltipHash,
        contentEditable: true,
        suppressContentEditableWarning: true,
        onInput: (event: { currentTarget: HTMLElement }) =>
          onChange(event.currentTarget.textContent ?? ''),
      },
      value,
    ),
}));
vi.mock('../preview', () => ({
  PreviewColumn: ({ baseText }: { baseText: string }) =>
    createElement(
      Fragment,
      null,
      createElement('div', { 'data-preview': '' }, baseText),
      liveHeader &&
        createElement(TooltipPreview, {
          name: 'Retained document',
          text: baseText,
          lang: 'de',
          globals: { variables: '', titles: '' },
          fill: true,
        }),
    ),
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
let router: ReturnType<typeof createMemoryRouter> | undefined;
let navigate: ReturnType<typeof useNavigate>;
let liveHeader = false;

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

async function mount(initialEntries = ['/t/100?lang=de']) {
  root = createRoot(host);
  router = createMemoryRouter(
    [
      {
        element: createElement(Fragment, null, createElement(RouteState), createElement(Layout)),
        children: [{ path: '/t/:hash', element: createElement(TooltipPage) }],
      },
    ],
    { initialEntries },
  );
  await act(async () => {
    root!.render(createElement(RouterProvider, { router: router! }));
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
  liveHeader = false;
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
  router?.dispose();
  router = undefined;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.remove());
  host.remove();
  document.body.style.overflow = '';
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  useSteppingActivity.setState({ active: false, deferWorkspace: false });
  settleStepping();
  vi.restoreAllMocks();
});

describe('mounted Editor navigation interaction ownership', () => {
  it.each(['popover', 'combobox'])(
    'blocks wheel and shortcuts in the opening event and resumes after Escape from a %s',
    async (kind) => {
      await mount();
      await act(async () => {
        flushSync(() => {
          if (kind === 'popover')
            host.querySelector<HTMLButtonElement>('[data-drafts-button]')!.click();
          else host.querySelector<HTMLInputElement>('input[role="combobox"]')!.click();
        });
        expect(workspaceShortcutsBlocked(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
        const wheel = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
          deltaY: 100,
        });
        host.dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBe(false);
        flushSync(() => {
          const target =
            kind === 'popover'
              ? document.activeElement!
              : host.querySelector('input[role="combobox"]')!;
          target.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          );
        });
        expect(workspaceShortcutsBlocked(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
        const next = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
          deltaY: 100,
        });
        host.dispatchEvent(next);
        expect(next.defaultPrevented).toBe(true);
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(route()).toBe('/t/101?lang=de');
    },
  );
  it('releases an expanded finder on unmount without closing its list', async () => {
    await mount();
    await click(host.querySelector<HTMLInputElement>('input[role="combobox"]')!);
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(true);
    await act(async () => root?.unmount());
    root = undefined;
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(false);
  });
  it('retains the latest header through history consolidation during a held boundary', async () => {
    vi.useFakeTimers();
    const scheduling = Object.getOwnPropertyDescriptor(navigator, 'scheduling');
    Object.defineProperty(navigator, 'scheduling', {
      configurable: true,
      value: { isInputPending: () => true },
    });
    try {
      liveHeader = true;
      await mount();
      const field = host.querySelector<HTMLInputElement>('input[aria-label="Tooltip"]')!;
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await vi.advanceTimersByTimeAsync(25);
      });
      expect(host.querySelector('[data-preview]')?.textContent).toBe('Deutsch 100');
      expect(host.querySelector('[data-shell-slot="left"] header')?.textContent).toContain(
        'Sample 101',
      );
      await act(async () => vi.advanceTimersByTimeAsync(1100));
      expect(useSteppingActivity.getState().active).toBe(true);
      expect(host.querySelector('[data-preview]')?.textContent).toBe('Deutsch 100');
      expect(host.querySelector('[data-shell-slot="left"] header')?.textContent).toContain(
        'Sample 101',
      );
      await act(async () => {
        const editor = host.querySelector<HTMLElement>('.cm-editor')!;
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
        expect(editor.dataset.documentHash).toBe('101');
      });
    } finally {
      if (scheduling) Object.defineProperty(navigator, 'scheduling', scheduling);
      else Reflect.deleteProperty(navigator, 'scheduling');
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));
      vi.useRealTimers();
    }
  });
  it('lands the URL synchronously on the first free frame while retaining the document', async () => {
    vi.useFakeTimers();
    let pending = true;
    const scheduling = Object.getOwnPropertyDescriptor(navigator, 'scheduling');
    Object.defineProperty(navigator, 'scheduling', {
      configurable: true,
      value: { isInputPending: () => pending },
    });
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 0;
    try {
      await mount();
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) => {
        callbacks.set(++next, run);
        return next;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => callbacks.delete(id));
      await act(async () => {
        host.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: 100 }),
        );
        const [id, frame] = callbacks.entries().next().value!;
        callbacks.delete(id);
        frame(0);
      });
      expect(route()).toBe('/t/100?lang=de');
      pending = false;
      await act(async () => {
        vi.advanceTimersByTime(2);
        const [id, frame] = callbacks.entries().next().value!;
        callbacks.delete(id);
        frame(2);
        expect(route()).toBe('/t/101?lang=de');
        expect(host.querySelector('[data-preview]')?.textContent).toBe('Deutsch 100');
      });
    } finally {
      if (scheduling) Object.defineProperty(navigator, 'scheduling', scheduling);
      else Reflect.deleteProperty(navigator, 'scheduling');
      vi.useRealTimers();
    }
  });
  it('keeps one burst history entry and restores the origin on Back after a Shift flick', async () => {
    vi.useFakeTimers();
    try {
      await mount(['/t/99', '/t/100?lang=de']);
      await act(async () => {
        for (let packet = 0; packet < 300; packet++)
          host.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              shiftKey: true,
              deltaY: 100,
            }),
          );
        await vi.advanceTimersByTimeAsync(1050);
      });
      expect(route()).toBe('/t/101?lang=de');
      await act(async () => navigate(-1));
      expect(route()).toBe('/t/100?lang=de');
      await act(async () => navigate(-1));
      expect(route()).toBe('/t/99');
      await act(async () => navigate(2));
      expect(route()).toBe('/t/101?lang=de');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lands the newest document before typing immediately after a Shift flick stops', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const edit = vi.fn();
      useDraftStore.setState({ edit });
      await act(async () => {
        for (let packet = 0; packet < 300; packet++)
          host.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              shiftKey: true,
              deltaY: 100,
            }),
          );
        await vi.advanceTimersByTimeAsync(17);
      });
      const editor = host.querySelector<HTMLElement>('.cm-editor')!;
      await act(async () =>
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })),
      );
      expect(route()).toBe('/t/101?lang=de');
      expect(editor.dataset.documentHash).toBe('101');
      await act(async () => {
        editor.textContent += 'x';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      });
      expect(edit).toHaveBeenCalledWith(
        data.bundle.tooltips[101],
        'de',
        'Deutsch 101x',
        'local draft',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('synchronously lands a pending router target when the editor receives focus', async () => {
    await mount();
    await act(async () => {
      useSteppingActivity.setState({ active: true, deferWorkspace: true });
      publishSteppingTarget('/t/101?lang=de', () =>
        navigate('/t/101?lang=de', { replace: true, flushSync: true }),
      );
    });
    expect(route()).toBe('/t/100?lang=de');
    const editor = host.querySelector<HTMLElement>('.cm-editor')!;
    await act(async () => editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(route()).toBe('/t/101?lang=de');
    expect(editor.dataset.documentHash).toBe('101');
  });

  it.each(['keydown', 'copy', 'contextmenu'])(
    'lands an accepted wheel target before %s even before its first frame',
    async (type) => {
      vi.useFakeTimers();
      try {
        await mount();
        const editor = host.querySelector<HTMLElement>('.cm-editor')!;
        await act(async () => {
          host.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              shiftKey: true,
              deltaY: 100,
            }),
          );
          editor.dispatchEvent(
            type === 'keydown'
              ? new KeyboardEvent(type, { key: 'x', bubbles: true })
              : new Event(type, { bubbles: true }),
          );
          expect(route()).toBe('/t/101?lang=de');
          expect(editor.dataset.documentHash).toBe('101');
        });
        expect(route()).toBe('/t/101?lang=de');
        expect(editor.dataset.documentHash).toBe('101');
        await act(async () => vi.advanceTimersByTimeAsync(25));
        expect(useSteppingActivity.getState().active).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('catches up before editing a retained document, so the new item owns the input', async () => {
    await mount();
    const edit = vi.fn();
    useDraftStore.setState({ edit });
    await act(async () => {
      useSteppingActivity.setState({ active: true, deferWorkspace: true });
      navigate('/t/101?lang=de');
    });
    const editor = host.querySelector<HTMLElement>('.cm-editor')!;
    expect(route()).toBe('/t/101?lang=de');
    expect(editor.dataset.documentHash).toBe('100');
    expect(editor.textContent).toBe('Deutsch 100');
    await act(async () => editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(host.querySelector('.cm-editor')).toBe(editor);
    expect(editor.dataset.documentHash).toBe('101');
    await act(async () => {
      editor.textContent = 'Newest item text';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    expect(edit).toHaveBeenCalledWith(
      data.bundle.tooltips[101],
      'de',
      'Newest item text',
      'local draft',
    );
    expect(useSteppingActivity.getState().active).toBe(false);
  });
  it.each([
    [-1, 'deltaY'],
    [-1, 'deltaX'],
    [1, 'deltaY'],
    [1, 'deltaX'],
  ] as const)(
    'consumes boundary Shift-wheel %s on %s without navigating',
    async (direction, axis) => {
      await mount();
      if (direction > 0) await shiftWheel();
      const before = route();
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        shiftKey: true,
        [axis]: direction * 100,
      });
      await act(async () => host.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(route()).toBe(before);
    },
  );
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
          await vi.advanceTimersByTimeAsync(17);
        });
        expect(document.querySelector('[data-preview]')?.textContent).toBe('Deutsch 100');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(16);
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

  it('lands a queued wheel step before a click opens a sheet', async () => {
    await mount();
    await act(async () => {
      host.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: 100 }),
      );
      draftsButton().click();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(overlay()).not.toBeNull();
    expect(route()).toBe('/t/101?lang=de');
    expect(selectedItem()).toBe('Sample 101');
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
    const release = observeNativeDialogShortcutOwner(dialog);

    const whileOpen = await shiftWheel();
    expect(whileOpen.defaultPrevented).toBe(false);
    expect(route()).toBe('/t/100?lang=de');
    expect(selectedItem()).toBe('Sample 100');

    dialog.removeAttribute('open');
    const afterClose = await shiftWheel();
    expect(afterClose.defaultPrevented).toBe(true);
    expect(route()).toBe('/t/101?lang=de');
    expect(selectedItem()).toBe('Sample 101');
    release();
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
