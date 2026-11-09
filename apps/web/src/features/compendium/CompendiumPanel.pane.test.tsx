// @vitest-environment jsdom
// The Compendium right pane: one 28px header (title, diff view, pick other row, zoom) over a
// scrolling body; the zoom is a device setting; the diff view moves above the diff in a narrow pane.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, Tooltip } from '@clarity/core';
import * as core from '@clarity/core';
import * as dates from '../../services/format/date';
import * as paneSkeleton from './CompendiumPaneSkeleton';
import * as rightPane from '../../ui/RightPane';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsStore } from '../../stores/settings';
import { useCompendiumStore } from './store';
import { CompendiumPanel } from './CompendiumPanel';
import * as diffCache from './compendiumDiffCache';
import { useDisplayMatches } from './useDisplayMatches';
import { backgroundDecodePaused } from './paneDecodeActivity';
import { useSteppingActivity } from '../navigation/steppingActivity';

const paneMatch = vi.hoisted(() => vi.fn());
const skeletonTiming = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../ui/Skeleton', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/Skeleton')>();
  return {
    ...actual,
    useSkeletonVisible: (...args: Parameters<typeof actual.useSkeletonVisible>) =>
      actual.useSkeletonVisible(skeletonTiming.enabled && args[0], args[1], args[2]),
  };
});
const matchState = vi.hoisted(() => ({
  loading: false,
  rows: undefined as Map<number, unknown> | undefined,
}));
vi.mock('./useDisplayMatches', () => ({
  useDisplayMatches: vi.fn(() => ({
    loading: matchState.loading,
    matches: { get: (hash: number) => (matchState.rows ? matchState.rows.get(hash) : paneMatch()) },
  })),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../../services/api', () => ({ apiUrl: 'https://api.test' }));
vi.mock('./LinkPicker', () => ({
  LinkPicker: ({ readOnly }: { readOnly?: boolean }) =>
    createElement(
      'div',
      { 'data-picker': true, 'data-readonly': String(!!readOnly) },
      createElement('input', { 'aria-label': 'Picker query', defaultValue: 'Initial search' }),
    ),
}));

const cell = (text: string): CompendiumCell => ({ plain: text, runs: [{ text }] });
const row = { name: 'Name', nameNorm: 'name', section: '', rowIndex: 1, cell: cell('New text') };
const tab = { gid: 'g1', name: 'Tab', rows: [row], grid: [] };
const linked = {
  hash: 5,
  text: {},
  associated: [],
  compendium: {
    gid: 'g1',
    rowKey: 'Name',
    section: '',
    snapshotAt: '2026-11-01T00:00:00Z',
    snapshot: cell('Old text'),
  },
} as unknown as Tooltip;
const roots: Root[] = [];
let width: number | undefined;

beforeEach(() => {
  skeletonTiming.enabled = false;
  paneMatch.mockReturnValue(undefined);
  matchState.loading = false;
  matchState.rows = undefined;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  useSettingsStore.setState({
    device: { ...useSettingsStore.getState().device, compendiumScale: 100, remembered: {} },
  });
  useAuthStore.setState({ user: { login: 'm', role: 'maintainer' } as never });
  useDataStore.setState({ data: null });
  useDraftStore.setState({ drafts: {}, hydrated: true } as never);
  useCompendiumStore.setState({
    data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [] },
    loading: false,
    error: null,
    load: async () => undefined,
  } as never);
  width = undefined;
  class FakeObserver {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) {
      this.notify(
        [
          {
            target,
            borderBoxSize: [{ inlineSize: width ?? 0, blockSize: 0 }],
            contentRect: { width: width ?? 0, height: 0 },
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: width ?? 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect,
  );
});
afterEach(() => {
  act(() => useSteppingActivity.setState({ active: false, deferWorkspace: false }));
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(base: Tooltip = linked) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(CompendiumPanel, { base })));
  return host;
}
const button = (host: ParentNode, label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
const header = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[aria-label="Compendium tools"]')!;
const diffViews = (host: ParentNode) =>
  host.querySelectorAll('[aria-label="Compendium diff view"]');

describe('Compendium pane', () => {
  it('keeps decoding live for language history on an unchanged active override', async () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const original = window.location.hash;
    try {
      window.history.replaceState(null, '', '#/t/10?variant=5&lang=en');
      await mount(linked);
      for (const lang of ['fr', 'en', 'fr']) {
        await act(async () => {
          for (const [id, callback] of [...frames]) {
            frames.delete(id);
            callback(16);
          }
          vi.runOnlyPendingTimers();
        });
        expect(backgroundDecodePaused()).toBe(false);
        await act(async () => {
          window.history.replaceState(null, '', `#/t/10?variant=5&lang=${lang}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
        expect(backgroundDecodePaused()).toBe(false);
      }
      // A different base route must still pause immediately, before React paints it.
      await act(async () => {
        window.history.replaceState(null, '', '#/t/11');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      expect(backgroundDecodePaused()).toBe(true);
    } finally {
      window.history.replaceState(null, '', original || '#/');
    }
  });

  it('lets cold source bootstrap finish, then releases background decode after the pane paints', async () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    useCompendiumStore.setState({ data: null, loading: true });
    await mount({ hash: 6, text: {}, associated: [] } as unknown as Tooltip);
    expect(backgroundDecodePaused()).toBe(false);
    await act(async () =>
      useCompendiumStore.setState({
        data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [] },
        loading: false,
      }),
    );
    expect(backgroundDecodePaused()).toBe(true);
    expect(frames.size).toBe(1);
    await act(async () => [...frames.values()][0](16));
    expect(backgroundDecodePaused()).toBe(true);
    await act(async () => vi.runOnlyPendingTimers());
    expect(backgroundDecodePaused()).toBe(false);
  });

  it.each([
    ['desktop', 'query'],
    ['phone', 'query'],
    ['desktop', 'close'],
    ['phone', 'close'],
  ])(
    'discards the inline picker and restores %s focus from its %s control on stepping',
    async (mode, focusedControl) => {
      const frames = new Map<number, FrameRequestCallback>();
      let serial = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++serial, callback);
        return serial;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      const host = await mount();
      const root = roots.at(-1)!;
      const finder = document.createElement('input');
      finder.setAttribute('aria-label', 'Tooltip');
      document.body.prepend(finder);
      const trigger = document.createElement('button');
      trigger.setAttribute('data-tooltip-finder', '');
      document.body.prepend(trigger);
      if (mode === 'phone') finder.hidden = true;
      await act(async () => button(host, 'Pick other row')!.click());
      const pane = host.querySelector('aside');
      const source = host.querySelector('[data-scale]');
      const query = host.querySelector<HTMLInputElement>('[aria-label="Picker query"]')!;
      query.value = 'Old picker state';
      (focusedControl === 'close' ? button(host, 'Close picker')! : query).focus();
      await act(async () => {
        useSteppingActivity.setState({ active: true });
        root.render(
          createElement(CompendiumPanel, { base: { ...linked, hash: 6 }, stepping: true }),
        );
      });
      expect(host.querySelector('[data-picker]')).toBeNull();
      expect(host.querySelector('[data-inline-link-picker]')).toBeNull();
      expect(query.isConnected).toBe(false);
      expect(host.querySelector('aside')).toBe(pane);
      expect(host.querySelector('[data-scale]')).toBe(source);
      expect(document.activeElement).toBe(mode === 'phone' ? trigger : finder);
      await act(async () => {
        useSteppingActivity.setState({ active: false });
        root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 6 } }));
      });
      expect(host.querySelector('[data-picker]')).toBeNull();
      await act(async () => {
        for (const callback of frames.values()) callback(0);
        frames.clear();
      });
      await act(async () => button(host, 'Pick other row')!.click());
      expect(host.querySelector<HTMLInputElement>('[aria-label="Picker query"]')?.value).toBe(
        'Initial search',
      );
    },
  );
  it('reveals data-sized skeletons after two frames and reuses their shimmer regions', async () => {
    skeletonTiming.enabled = true;
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const host = await mount();
    const root = roots.at(-1)!;
    const content = host.querySelector('[data-scale]');
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 6 }, stepping: true })),
    );
    expect(host.querySelector('[data-pane-skeleton]')).toBeNull();
    const tick = async () => {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      await act(async () => callback(0));
    };
    await tick();
    expect(host.querySelector('[data-pane-skeleton]')).toBeNull();
    await tick();
    const skeleton = host.querySelector('[data-pane-skeleton]');
    expect(skeleton).not.toBeNull();
    expect(host.querySelector('[data-scale]')).toBe(content);
    expect(content?.hasAttribute('hidden')).toBe(true);
    expect(skeleton?.textContent).toContain('Name');
    expect(skeleton?.textContent).toContain('Snapshot');
    expect(skeleton?.querySelector('button')?.disabled).toBe(true);
    const region = skeleton?.querySelector('[aria-hidden="true"]');
    const cellRegion = skeleton?.querySelector('[class*="skeletonCell"]');
    const newest = {
      ...linked,
      hash: 7,
      compendium: { ...linked.compendium!, rowKey: 'Latest row', gid: 'g2' },
    };
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: newest, stepping: true })),
    );
    expect(host.querySelector('[data-pane-skeleton]')).toBe(skeleton);
    expect(skeleton?.querySelector('[aria-hidden="true"]')).toBe(region);
    expect(skeleton?.querySelector('[class*="skeletonCell"]')).toBe(cellRegion);
    expect(skeleton?.textContent).toContain('Latest row');
    // The newer entry gets its own two frames before the minimum restarts for it.
    expect(frames.size).toBe(1);
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: newest, stepping: false })),
    );
    // The pane commits within the newer entry's two frames, so it shows with no minimum wait.
    for (let guard = 0; frames.size && guard < 4; guard++) await tick();
    expect(host.querySelector('[data-pane-skeleton]')).toBeNull();
    expect(host.querySelector('[data-match-hash]')?.getAttribute('data-match-hash')).toBe('7');
    expect(host.querySelector('aside')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('retains the mounted pane while the skeleton is deferred and commits the latest entry', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    useCompendiumStore.setState({
      data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] },
    } as never);
    const host = await mount();
    const root = roots.at(-1)!;
    const original = host.innerHTML;
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: linked, stepping: false })),
    );
    expect(host.innerHTML).toBe(original);
    const content = host.querySelector('[data-scale]')!;
    const prepare = vi.spyOn(diffCache, 'prepareCompendiumDiff').mockReturnValue(undefined);
    for (const hash of [6, 7]) {
      await act(async () =>
        root.render(createElement(CompendiumPanel, { base: { ...linked, hash }, stepping: true })),
      );
      expect(host.querySelector('[data-scale]')).toBe(content);
      expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe(
        `Compendium for ${hash}`,
      );
      expect(content.getAttribute('data-match-hash')).toBe('5');
      expect(host.querySelector('aside')?.getAttribute('aria-busy')).toBe('true');
      expect(content.hasAttribute('inert')).toBe(true);
      expect(
        [...header(host).querySelectorAll('button')].every((control) => control.disabled),
      ).toBe(true);
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading Compendium…');
      expect(host.querySelector('[data-pane-skeleton]')).toBeNull();
      expect(vi.mocked(useDisplayMatches).mock.calls.at(-1)?.[4]).toBe(5);
      expect(prepare).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
    }
    await act(async () =>
      root.render(
        createElement(CompendiumPanel, { base: { ...linked, hash: 7 }, stepping: false }),
      ),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);
    await act(async () => [...frames.values()][0](0));
    expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe('Compendium for 7');
    expect(host.querySelector('aside')?.hasAttribute('aria-busy')).toBe(false);
    expect(host.querySelector('[data-scale]')?.hasAttribute('inert')).toBe(false);
    expect(header(host).hasAttribute('inert')).toBe(false);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('cancels a queued handoff when stepping starts and commits only the latest stop', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const host = await mount();
    const root = roots.at(-1)!;
    const content = host.querySelector('[data-scale]');
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 6 } })),
    );
    expect(frames.size).toBe(1);
    const superseded = [...frames.values()][0];
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 7 }, stepping: true })),
    );
    expect(frames.size).toBe(0);
    await act(async () => superseded(0));
    expect(host.querySelector('[data-scale]')).toBe(content);
    expect(host.querySelector('[data-match-hash]')?.getAttribute('data-match-hash')).toBe('5');
    await act(async () =>
      root.render(
        createElement(CompendiumPanel, { base: { ...linked, hash: 8 }, stepping: false }),
      ),
    );
    expect(frames.size).toBe(1);
    await act(async () => [...frames.values()][0](0));
    expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe('Compendium for 8');
    expect(host.querySelector('aside')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('does not retain a transition queued just before stepping begins', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    useCompendiumStore.setState({
      data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] },
    } as never);
    const host = await mount();
    const root = roots.at(-1)!;
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 6 } })),
    );
    const queued = [...frames.values()][0];
    frames.clear();
    await act(async () => {
      queued(0);
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 7 }, stepping: true }));
    });
    expect(host.querySelector('[data-match-hash]')?.getAttribute('data-match-hash')).toBe('5');
    await act(async () =>
      root.render(
        createElement(CompendiumPanel, { base: { ...linked, hash: 8 }, stepping: false }),
      ),
    );
    expect(host.querySelector('[data-match-hash]')?.getAttribute('data-match-hash')).toBe('5');
    await act(async () => [...frames.values()][0](0));
    expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe('Compendium for 8');
  });

  it('waits for an incoming match before scheduling the pane handoff', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const oldBase = { ...linked, compendium: undefined };
    const nextBase = { ...oldBase, hash: 6 };
    const oldMatch = { status: 'ok', changed: false, tab, row };
    matchState.rows = new Map([[5, oldMatch]]);
    const host = await mount(oldBase);
    matchState.loading = true;
    await act(async () => roots.at(-1)!.render(createElement(CompendiumPanel, { base: nextBase })));
    expect(frames.size).toBe(0);
    expect(host.textContent).toContain('New text');
    expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe('Compendium for 5');
    expect(host.querySelector('aside')?.getAttribute('aria-busy')).toBe('true');
    expect(button(host, 'Accept match (local draft)')?.disabled).toBe(true);
    matchState.rows = new Map([[6, { ...oldMatch, row: { ...row, cell: cell('Incoming row') } }]]);
    matchState.loading = false;
    await act(async () => roots.at(-1)!.render(createElement(CompendiumPanel, { base: nextBase })));
    expect(frames.size).toBe(1);
    await act(async () => [...frames.values()][0](0));
    expect(host.textContent).toContain('Incoming row');
    expect(host.querySelector('aside')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('retains the displayed match while a priority reply contains only the next tooltip', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const oldBase = { ...linked, compendium: undefined };
    const nextBase = { ...oldBase, hash: 6 };
    const oldMatch = { status: 'ok', changed: false, tab, row };
    const nextMatch = { ...oldMatch, row: { ...row, cell: cell('Next source row') } };
    matchState.rows = new Map([[5, oldMatch]]);
    const host = await mount(oldBase);
    expect(host.textContent).toContain('New text');
    matchState.rows = new Map([[6, nextMatch]]);
    await act(async () => roots.at(-1)!.render(createElement(CompendiumPanel, { base: nextBase })));
    expect(host.querySelector('aside')?.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).toContain('New text');
    expect(host.textContent).not.toContain('Next source row');
    expect(button(host, 'Accept match (local draft)')?.disabled).toBe(true);
    await act(async () => [...frames.values()][0](0));
    expect(host.textContent).toContain('Next source row');
    expect(host.querySelector('aside')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('ignores late diff preparation for a superseded tooltip', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    let resolveFirst!: () => void;
    let resolveLatest!: () => void;
    vi.spyOn(diffCache, 'prepareCompendiumDiff')
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveLatest = resolve;
        }),
      );
    useCompendiumStore.setState({
      data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] },
    } as never);
    const host = await mount();
    const root = roots.at(-1)!;
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 6 } })),
    );
    expect(frames.size).toBe(0);
    expect(host.querySelector('aside')?.getAttribute('aria-busy')).toBe('true');
    await act(async () =>
      root.render(createElement(CompendiumPanel, { base: { ...linked, hash: 7 } })),
    );
    await act(async () => resolveFirst());
    expect(frames.size).toBe(0);
    await act(async () => resolveLatest());
    expect(frames.size).toBe(1);
    await act(async () => [...frames.values()][0](0));
    expect(host.querySelector('aside')?.getAttribute('aria-label')).toBe('Compendium for 7');
    expect(host.querySelector('aside')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('commits only the latest frame target and pauses actions while older content is visible', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const intermediate: Tooltip = {
      ...linked,
      hash: 6,
      compendium: { ...linked.compendium!, snapshot: cell('Intermediate snapshot') },
    };
    const latest: Tooltip = {
      ...linked,
      hash: 7,
      compendium: { ...linked.compendium!, snapshot: cell('Latest snapshot') },
    };
    const original = useDraftStore.getState().updateDraft;
    const updateDraft = vi.fn();
    useDraftStore.setState({ updateDraft });
    try {
      const host = await mount();
      const root = roots.at(-1)!;
      expect(host.querySelector('aside')!.hasAttribute('aria-busy')).toBe(false);
      await act(async () => button(host, 'Pick other row')!.click());
      const picker = host.querySelector('[data-picker]')!;
      expect(picker.getAttribute('data-readonly')).toBe('false');
      await act(async () => root.render(createElement(CompendiumPanel, { base: intermediate })));
      expect(host.textContent).toContain('Old text');
      expect(host.querySelector('aside')!.getAttribute('aria-busy')).toBe('true');
      expect(host.querySelector('[data-picker]')).toBe(picker);
      expect(picker.getAttribute('data-readonly')).toBe('true');
      expect((button(host, 'Unlink (local draft)') as HTMLButtonElement).disabled).toBe(true);
      await act(async () => button(host, 'Unlink (local draft)')!.click());
      expect(updateDraft).not.toHaveBeenCalled();
      const pending = [...frames.values()][0];
      frames.clear();
      await act(async () => root.render(createElement(CompendiumPanel, { base: latest })));
      // Even a callback already dispatched by the browser must reject its
      // superseded target, without clearing the newer frame's cancellation.
      await act(async () => pending(0));
      expect(host.textContent).toContain('Old text');
      expect(host.textContent).not.toContain('Intermediate snapshot');
      expect((button(host, 'Unlink (local draft)') as HTMLButtonElement).disabled).toBe(true);
      const finalFrame = [...frames.values()][0];
      frames.clear();
      await act(async () => finalFrame(16));
      expect(host.textContent).toContain('Latest snapshot');
      expect(host.querySelector('aside')!.hasAttribute('aria-busy')).toBe(false);
      expect(picker.getAttribute('data-readonly')).toBe('false');
      expect(host.textContent).not.toContain('Intermediate snapshot');
      await act(async () => button(host, 'Unlink (local draft)')!.click());
      expect(updateDraft.mock.calls[0][0]).toBe(latest);
    } finally {
      act(() => useDraftStore.setState({ updateDraft: original }));
    }
  });

  it('reuses the status row for a priority match without waiting for full catalog metadata', async () => {
    const base = { hash: 6, text: {}, associated: [] } as unknown as Tooltip;
    matchState.loading = true;
    const host = await mount(base);
    const status = host.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('Matching Compendium…');
    expect(vi.mocked(useDisplayMatches).mock.calls.at(-1)?.[4]).toBe(base.hash);
    paneMatch.mockReturnValue({ status: 'ok', changed: false, tab, row });
    // The pane must also tolerate a late loading subscriber: the match is authoritative.
    await act(async () => useDraftStore.setState({ drafts: { 6: { base, next: base } } }));
    expect(host.contains(status)).toBe(true);
    expect(status.textContent).toContain('Matched');
    expect(status.getAttribute('role')).toBeNull();
    expect(host.textContent).not.toContain('Matching Compendium…');
    const cell = host.querySelector('[data-multiline]');
    matchState.loading = false;
    await act(async () => useDraftStore.setState({ drafts: {} }));
    expect(host.contains(status)).toBe(true);
    expect(host.querySelector('[data-multiline]')).toBe(cell);
  });

  it.each(['linked', 'matched'] as const)(
    'leaves the settled %s skeleton, pane, and shape cache idle through text edits',
    async (kind) => {
      skeletonTiming.enabled = true;
      const frame = vi.fn();
      vi.stubGlobal('requestAnimationFrame', frame);
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
      const renderPane = vi.spyOn(rightPane, 'RightPane');
      const remember = vi.spyOn(paneSkeleton, 'rememberPaneSkeleton');
      const format = vi.spyOn(dates, 'formatDate');
      const base = kind === 'linked' ? linked : { ...linked, compendium: undefined };
      if (kind === 'matched') paneMatch.mockReturnValue({ status: 'ok', changed: false, tab, row });
      const next = structuredClone(base);
      next.text = { en: { text: 'Existing draft' } } as Tooltip['text'];
      useDraftStore.setState({ drafts: { [base.hash]: { base, next } } });
      const host = await mount(base);
      const rendered = renderPane.mock.calls.length;
      const remembered = remember.mock.calls.length;
      const formatted = format.mock.calls.length;
      const original = host.innerHTML;
      frame.mockClear();
      for (let key = 0; key < 300; key++) {
        const changed = structuredClone(next);
        changed.text = { en: { text: `Existing draft ${key}` } } as Tooltip['text'];
        await act(async () =>
          useDraftStore.setState({ drafts: { [base.hash]: { base, next: changed } } }),
        );
      }
      expect(renderPane.mock.calls.length).toBe(rendered);
      expect(remember.mock.calls.length).toBe(remembered);
      expect(format.mock.calls.length).toBe(formatted);
      expect(frame).not.toHaveBeenCalled();
      expect(host.querySelector('[data-pane-skeleton]')).toBeNull();
      expect(host.querySelector('[class*="Skeleton_region"]')).toBeNull();
      expect(host.innerHTML).toBe(original);
    },
  );

  it('does not remeasure the root or resolve an unchanged source while English drafts are typed', async () => {
    useCompendiumStore.setState({ data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] } });
    const resolve = vi.spyOn(core, 'resolveCompendiumLink');
    const css = vi.spyOn(globalThis, 'getComputedStyle');
    await mount();
    const resolutions = resolve.mock.calls.length;
    const rootReads = () =>
      css.mock.calls.filter(([element]) => element === document.documentElement).length;
    const measured = rootReads();
    for (const text of ['A', 'Ab', 'Abc']) {
      const next = structuredClone(linked);
      next.text = { en: { text } } as Tooltip['text'];
      await act(async () =>
        useDraftStore.setState({ drafts: { [linked.hash]: { base: linked, next } } }),
      );
    }
    expect(resolve.mock.calls).toHaveLength(resolutions);
    expect(rootReads()).toBe(measured);
  });

  it('keeps the unlinked loading body unchanged when the first text draft is created', async () => {
    const base = { hash: 6, text: {}, associated: [] } as unknown as Tooltip;
    matchState.loading = true;
    const format = vi.spyOn(dates, 'formatDate');
    const host = await mount(base);
    const formatted = format.mock.calls.length;
    const status = host.querySelector('[role="status"]');
    for (const text of ['A', 'Ab', 'Abc']) {
      const next = { ...base, text: { en: { text } } } as Tooltip;
      await act(async () => useDraftStore.setState({ drafts: { 6: { base, next } } }));
    }
    expect(format.mock.calls).toHaveLength(formatted);
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe('Matching Compendium…');
  });

  it('labels an unsaved match honestly, then accepts only its link into the existing draft', async () => {
    const base = { hash: 6, text: {}, associated: [] } as unknown as Tooltip;
    const next = { ...base, text: { en: { text: 'Keep my text edit' } } } as Tooltip;
    const updateDraft = vi.fn();
    const original = useDraftStore.getState().updateDraft;
    useCompendiumStore.setState({ data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] } });
    useDraftStore.setState({ drafts: { 6: { base, next } }, updateDraft });
    paneMatch.mockReturnValue({ status: 'ok', changed: false, tab, row });
    try {
      const host = await mount(base);
      expect(host.querySelector('[title="Matched automatically — not saved"]')?.textContent).toBe(
        'Matched',
      );
      expect(host.textContent).toContain('No saved snapshot to compare.');
      expect(host.textContent).not.toContain('Matches the saved snapshot.');
      expect(diffViews(host)).toHaveLength(0);
      await act(async () => button(host, 'Accept match (local draft)')!.click());
      const accepted = updateDraft.mock.calls[0][1](next);
      expect(accepted.text).toEqual(next.text);
      expect(accepted.compendium.rowKey).toBe('Name');
      expect(base.compendium).toBeUndefined();
    } finally {
      act(() => useDraftStore.setState({ updateDraft: original }));
    }
  });

  it('saved and draft links hide matcher provenance and expose draft review', async () => {
    paneMatch.mockReturnValue({ status: 'ok', changed: false, tab, row });
    const host = await mount();
    expect(host.textContent).not.toContain('Accept match');
    expect(host.querySelector('[title="Matched automatically — not saved"]')).toBeNull();
    await act(async () =>
      useDraftStore.setState({ drafts: { 5: { base: linked, next: linked } } }),
    );
    expect(button(host, 'Review & save draft')).toBeTruthy();
  });
  it('has one header with the title, pick other row and zoom; the body keeps the snapshot', async () => {
    const host = await mount();
    expect(header(host).querySelector('h3')?.textContent).toBe('Compendium');
    expect(button(header(host), 'Pick other row')).toBeTruthy();
    expect(header(host).querySelector('[aria-label="Compendium zoom"] output')?.textContent).toBe(
      '100%',
    );
    expect(host.querySelectorAll('h3')).toHaveLength(1);
    expect(host.textContent).toContain('Old text');
    expect(host.textContent).toContain('Source fetched');
  });

  it('says so when no row is linked, and offers to link one from the header', async () => {
    const host = await mount({ hash: 6, text: {}, associated: [] } as unknown as Tooltip);
    expect(host.textContent).toContain('No Compendium row linked yet.');
    expect(button(header(host), 'Link a row')).toBeTruthy();
  });

  it('opens the row picker in the pane from the header and closes it again', async () => {
    const host = await mount();
    expect(host.querySelector('[data-picker]')).toBeNull();
    await act(async () => button(host, 'Pick other row')!.click());
    expect(host.querySelector('[data-picker]')).not.toBeNull();
    expect(button(host, 'Close picker')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => button(host, 'Close picker')!.click());
    expect(host.querySelector('[data-picker]')).toBeNull();
  });

  it('steps the zoom 100 to 70, clamps at both ends, and keeps it on this device', async () => {
    const host = await mount();
    const zoomed = () => host.querySelector<HTMLElement>('[data-scale]')!;
    const smaller = button(host, 'Smaller') as HTMLButtonElement;
    const larger = button(host, 'Larger') as HTMLButtonElement;
    expect(larger.disabled).toBe(true);
    for (const expected of [90, 80, 70]) {
      await act(async () => smaller.click());
      expect(header(host).querySelector('output')?.textContent).toBe(`${expected}%`);
      expect(zoomed().dataset.scale).toBe(String(expected));
      expect(zoomed().style.zoom).toBe(String(expected / 100));
    }
    expect(smaller.disabled).toBe(true);
    expect(useSettingsStore.getState().device.compendiumScale).toBe(70);
    expect(useSettingsStore.getState().pending).toEqual([]);
    await act(async () => larger.click());
    expect(useSettingsStore.getState().device.compendiumScale).toBe(80);
  });

  it('resetting pane widths puts the zoom back to 100 %', async () => {
    useSettingsStore.getState().updateDevice({ compendiumScale: 70 });
    const host = await mount();
    expect(header(host).querySelector('output')?.textContent).toBe('70%');
    await act(async () => void useSettingsStore.getState().resetPaneWidths());
    expect(header(host).querySelector('output')?.textContent).toBe('100%');
  });

  it('hides the pick button without edit rights and still shows the zoom', async () => {
    useAuthStore.setState({ user: null });
    const host = await mount();
    expect(button(host, 'Pick other row')).toBeUndefined();
    expect(button(host, 'Smaller')).toBeTruthy();
  });

  it('puts the diff view in the header when roomy and above the diff when narrow', async () => {
    useCompendiumStore.setState({
      data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] },
    } as never);
    width = 520;
    let host = await mount();
    expect(diffViews(header(host))).toHaveLength(1);
    expect(diffViews(host)).toHaveLength(1);
    document.body.replaceChildren();
    width = 320;
    host = await mount();
    expect(diffViews(header(host))).toHaveLength(0);
    expect(diffViews(host)).toHaveLength(1);
    // Choosing Before / After still switches the diff, wherever the switch sits.
    await act(async () => button(host, 'Before / After')!.click());
    expect(host.textContent).toContain('Snapshot');
    expect(host.textContent).toContain('Current');
    expect(useSettingsStore.getState().device.remembered.compendiumDiff).toBe('before-after');
  });

  describe('sheet colours', () => {
    const surfaces = (host: ParentNode) => [
      ...host.querySelectorAll<HTMLElement>('[data-surface]'),
    ];
    const withCell = (cellOverride: Partial<CompendiumCell>) =>
      useCompendiumStore.setState({
        data: {
          fetchedAt: '2026-11-01T00:00:00Z',
          tabs: [{ ...tab, rows: [{ ...row, cell: { ...row.cell, ...cellOverride } }] }],
        },
      } as never);

    it("shows the cell on the sheet's own background by default, with a header toggle", async () => {
      withCell({ background: '#2e3c4e' });
      const host = await mount();
      const toggle = button(header(host), 'Sheet colours')!;
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      const [cell] = surfaces(host);
      expect(cell.dataset.surface).toBe('sheet');
      expect(cell.style.background).toBe('rgb(46, 60, 78)');
    });

    it('switches to the editor surface, remembers it on this device, and switches back', async () => {
      withCell({ background: '#2e3c4e' });
      const host = await mount();
      await act(async () => button(header(host), 'Sheet colours')!.click());
      const [cell] = surfaces(host);
      expect(cell.dataset.surface).toBe('editor');
      expect(cell.style.background).toBe('');
      expect(button(header(host), 'Sheet colours')!.getAttribute('aria-pressed')).toBe('false');
      expect(useSettingsStore.getState().device.remembered.compendiumSurface).toBe('editor');
      expect(useSettingsStore.getState().pending).toEqual([]);
      await act(async () => button(header(host), 'Sheet colours')!.click());
      expect(surfaces(host)[0].dataset.surface).toBe('sheet');
    });

    it('uses the editor surface for a cell the sheet gave no background', async () => {
      withCell({});
      const host = await mount();
      expect(surfaces(host).every((cell) => cell.dataset.surface === 'editor')).toBe(true);
    });

    it('keeps the sheet text colours exactly on a sheet background, and makes them AA on the editor surface', async () => {
      withCell({
        background: '#efeded',
        runs: [{ text: 'New text', color: '#783f04' }],
      });
      const host = await mount();
      const colour = () =>
        surfaces(host)[0].querySelector<HTMLElement>('span[style*="color"]')!.style.color;
      expect(colour()).toBe('rgb(120, 63, 4)');
      // On the editor surface that dark brown would be unreadable, so it is lifted to AA.
      await act(async () => button(header(host), 'Sheet colours')!.click());
      expect(colour()).not.toBe('rgb(120, 63, 4)');
      expect(colour()).not.toBe('');
    });
  });
});
import linksFixture from './fixtures/compendium-links.json';
import { reviewedOwnerDecision } from './ownerReviewed';
import { guidedFixture } from '../../../test/guided-fixture';
import type { EditorData } from '../../stores/data';

it.each([4019266109, 2613226185, 1888882410, 3684445958])(
  'compares approval evidence for unsaved owner-approved Collective %s without writing a snapshot',
  async (hash) => {
    const f = guidedFixture();
    f.editor.items = linksFixture.items as EditorData['items'];
    f.editor.bundle.tooltips = {};
    const source = core.compendiumDataSchema.parse(linksFixture.source);
    const item = f.editor.items[hash];
    const base: Tooltip = { hash, text: {}, associated: [] };
    const decision = reviewedOwnerDecision(
      {
        ...f.categories[0].entries[0],
        hash,
        name: item.name,
        category: item.categoryId,
        base,
        next: base,
      },
      undefined,
      source,
    )!;
    const resolved = core.resolveCompendiumLink(decision.link!, source);
    if (!('row' in resolved)) throw new Error('Missing approved source');
    expect(resolved.row.name).toBe(item.name);
    expect(resolved.row.anchor?.row).toBe(item.name === 'Collective Demolition' ? 52 : 53);
    useDataStore.setState({ data: f.editor });
    useCompendiumStore.setState({ data: source });
    paneMatch.mockReturnValue(resolved);
    const before = JSON.stringify([f.editor, source]);
    const host = await mount(base);
    expect(host.textContent).toContain('Compendium sheet changed since approval.');
    expect(host.textContent).not.toContain('No saved snapshot to compare.');
    expect(host.textContent).toContain(`Weapon Perks / ${item.name}`);
    expect(diffViews(host)).toHaveLength(1);
    expect(base.compendium).toBeUndefined();
    expect(JSON.stringify([f.editor, source])).toBe(before);
  },
);
