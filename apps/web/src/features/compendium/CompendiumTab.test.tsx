// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { useCompendiumStore } from './store';
import { useCompendiumQueueStore } from './queueStore';
import { useAdvanceSetting } from './advanceSetting';
import { CompendiumQueue } from './CompendiumQueue';
import { CompendiumTab } from './CompendiumTab';

const captured = vi.hoisted(() => ({ proposals: new Map() }));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: captured.proposals, loading: false, error: null }),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.invalid',
}));

let host: HTMLDivElement;
let root: Root;
let fixture: ReturnType<typeof guidedFixture>;

function Location() {
  const location = useLocation();
  return createElement('output', { 'data-route': '' }, location.pathname + location.search);
}
const route = () =>
  new URL(host.querySelector('[data-route]')!.textContent!, 'https://synthetic.invalid');
const title = () =>
  host.querySelector('[aria-label="Entry to review"] [role="heading"]')?.textContent ?? '';
const bar = () => host.querySelector('[aria-label="Review actions"]')!;
const press = async (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
const barButton = (text: string) =>
  [...bar().querySelectorAll('button')].find((button) => button.textContent?.startsWith(text))!;
const draftLink = (hash: number) => useDraftStore.getState().drafts[hash]?.next.compendium;

async function mount(path = '/compendium', withQueue = false) {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { key: path, initialEntries: [path] },
        createElement(
          Fragment,
          null,
          createElement(Location),
          withQueue && createElement(CompendiumQueue),
          createElement(CompendiumTab),
        ),
      ),
    ),
  );
}
const typeSearch = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('[data-compendium-search]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
};

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
  captured.proposals = fixture.proposals;
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('Blocked network'))));
  useDataStore.setState({ data: fixture.editor, status: 'ready', error: null, load: async () => {} });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    pending: 0,
    error: null,
    hydrate: async () => {},
    activate: async () => {},
  });
  useAuthStore.setState({ user: { id: 1, login: 'ed', role: 'editor' }, loading: false });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({
    data: fixture.source,
    loading: false,
    error: null,
    load: async () => {},
  });
  useAdvanceSetting.setState({ ms: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  await useDraftStore.getState().flush();
  host.remove();
  useCompendiumQueueStore.setState({ rows: null, selected: undefined, toggled: new Set() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('keyboard review flow', () => {
  it('drafts the first proposal with one Enter, then moves to the next open entry', async () => {
    await mount();
    expect(title()).toContain('Sample 100');
    expect(barButton('Confirm').hasAttribute('disabled')).toBe(false);
    await press('Enter');
    expect(draftLink(100)?.rowKey).toBe('Sample 100');
    expect(route().searchParams.get('hash')).toBe('101');
    expect(title()).toContain('Sample 101');
    // The drafted entry leaves the open count and stays reachable as decided.
    expect(host.querySelector('header p')?.textContent).toContain('5 to review');
    expect(bar().textContent).not.toContain('Cannot');
  });

  it('A confirms too, and Undo restores the link, the count, and the selection', async () => {
    await mount();
    await press('a');
    expect(draftLink(100)).toBeTruthy();
    await press('u');
    expect(draftLink(100)).toBeUndefined();
    expect(route().searchParams.get('hash')).toBe('100');
    expect(host.querySelector('header p')?.textContent).toContain('6 to review');
  });

  it('S skips and N marks not needed, both locally; neither drafts a link', async () => {
    await mount();
    await press('s');
    expect(title()).toContain('Sample 101');
    await press('n');
    expect(title()).toContain('Sample 102');
    expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);
    const stored = JSON.parse(
      [...Array(localStorage.length).keys()]
        .map((i) => localStorage.getItem(localStorage.key(i)!)!)
        .find((value) => value.includes('"decisions"'))!,
    );
    expect(Object.values(stored.decisions as Record<string, { kind: string }>).map((d) => d.kind)).toEqual(
      ['skipped', 'no-equivalent'],
    );
    expect(host.querySelector('header p')?.textContent).toContain('4 to review');
    expect(host.querySelector('header p')?.textContent).toContain('1 not needed');
  });

  it('arrows, J/K, Home, and End move the selection by replacing history', async () => {
    await mount();
    await press('ArrowDown');
    expect(title()).toContain('Sample 101');
    await press('j');
    expect(title()).toContain('Sample 102');
    await press('End');
    expect(title()).toContain('Sample 105');
    await press('k');
    expect(title()).toContain('Sample 104');
    await press('Home');
    expect(title()).toContain('Sample 100');
    expect(route().searchParams.get('hash')).toBe('100');
  });

  it('ignores shortcuts while typing and with modifier keys', async () => {
    await mount();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    });
    await press('s', { ctrlKey: true });
    expect(title()).toContain('Sample 100');
    input.remove();
  });
});

describe('auto-advance pause', () => {
  it('waits, ignores decision keys during the pause, and moves on by itself', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 600 });
    await mount();
    await press('Enter');
    expect(draftLink(100)).toBeTruthy();
    expect(title()).toContain('Sample 100');
    expect(bar().textContent).toContain('Next: Sample 101');
    // Decision keys never act on an entry the user has not seen.
    await press('s');
    await press('a');
    await press('n');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['100']);
    await act(async () => {
      vi.advanceTimersByTime(650);
    });
    expect(title()).toContain('Sample 101');
    expect(bar().textContent).not.toContain('Next:');
  });

  it('Esc stays on the decided entry and cancels the move', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 600 });
    await mount();
    await press('Enter');
    await press('Escape');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(title()).toContain('Sample 100');
    expect(bar().textContent).not.toContain('Next:');
    // The URL holds the entry the user chose to stay on.
    expect(route().searchParams.get('hash')).toBe('100');
  });

  it('Enter or Down advances immediately, once', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 600 });
    await mount();
    await press('Enter');
    await press('Enter');
    expect(title()).toContain('Sample 101');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['100']);
    await press('Enter');
    await press('ArrowDown');
    expect(title()).toContain('Sample 102');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['100', '101']);
  });

  it('a click on another entry cancels a pending move', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 600 });
    await mount();
    await press('Enter');
    await press('End');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(title()).toContain('Sample 105');
  });

  it('a search typed during the pause keeps the search and the decided entry', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 300 });
    await mount('/compendium', true);
    await press('Enter');
    expect(bar().textContent).toContain('Next: Sample 101');
    // Typed late in the pause: its URL commit (150 ms) lands after the move would have.
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    const input = await typeSearch('Sample');
    expect(bar().textContent).not.toContain('Next:');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(route().searchParams.get('q')).toBe('Sample');
    expect(input.value).toBe('Sample');
    expect(title()).toContain('Sample 100');
    expect(route().searchParams.get('hash')).toBe('100');
  });

  it('a row tapped in the queue during the pause wins over the move', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 600 });
    // A list viewport tall enough to render every queue row.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    await mount('/compendium', true);
    // Past the queue skeleton's minimum time.
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await press('Enter');
    const rows = [...host.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"]')];
    const other = rows.find((row) => !/^cq-row-10[01]$/.test(row.id))!;
    const hash = other.id.replace('cq-row-', '');
    await act(async () => {
      other.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(title()).toContain(`Sample ${hash}`);
    expect(route().searchParams.get('hash')).toBe(hash);
    expect(bar().textContent).not.toContain('Next:');
  });
});

describe('linked sources view', () => {
  it('keeps the queue listed, takes no review keys, and returns without a rebuild', async () => {
    vi.useFakeTimers();
    await mount('/compendium?tab=linked&hash=101', true);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(host.querySelector('[aria-label="Linked sources changed"]')).toBeTruthy();
    expect(host.textContent).not.toContain('Loading the review queue');
    expect(host.querySelector('[aria-selected="true"]')?.id).toBe('cq-row-101');
    await press('Enter');
    await press('ArrowDown');
    expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);
    expect(route().searchParams.get('tab')).toBe('linked');
    const back = [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('Back to the'))!;
    await act(async () => {
      back.click();
    });
    expect(route().searchParams.has('tab')).toBe(false);
    expect(title()).toContain('Sample 101');
    expect(host.textContent).not.toContain('Loading the review queue');
  });
});

describe('more actions menu', () => {
  const menu = () => bar().querySelector('details')!;
  const openMenu = async () =>
    act(async () => {
      menu().open = true;
      menu().dispatchEvent(new Event('toggle'));
    });

  it('closes on Escape before the pause sees it, and on a press outside', async () => {
    vi.useFakeTimers();
    useAdvanceSetting.setState({ ms: 600 });
    await mount();
    await press('Enter');
    await openMenu();
    await press('Escape', { cancelable: true });
    expect(menu().open).toBe(false);
    expect(document.activeElement).toBe(menu().querySelector('summary'));
    // One Escape, one thing closed: the pause still runs.
    expect(bar().textContent).toContain('Next: Sample 101');
    await act(async () => {
      vi.advanceTimersByTime(650);
    });
    expect(title()).toContain('Sample 101');
    await openMenu();
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(menu().open).toBe(false);
  });

  it('closes once its Undo or pause choice ran', async () => {
    await mount();
    await press('s');
    await openMenu();
    await act(async () => {
      menu().querySelector('button')!.click();
    });
    expect(menu().open).toBe(false);
    expect(title()).toContain('Sample 100');
    await openMenu();
    const select = menu().querySelector('select')!;
    await act(async () => {
      select.value = '1000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(menu().open).toBe(false);
    expect(useAdvanceSetting.getState().ms).toBe(1000);
  });
});

describe('permissions and states', () => {
  it('lets a viewer browse and skip, but not draft links', async () => {
    useAuthStore.setState({ user: { id: 2, login: 'reader', role: 'translator' } });
    await mount();
    expect(barButton('Confirm').hasAttribute('disabled')).toBe(true);
    expect(barButton('Pick row').hasAttribute('disabled')).toBe(true);
    expect(bar().textContent).toContain('Viewing only');
    await press('Enter');
    await press('a');
    expect(useDraftStore.getState().drafts).toEqual({});
    await press('s');
    expect(title()).toContain('Sample 101');
  });

  it('pins an entry opened from the editor even when the filters hide it', async () => {
    await mount('/compendium?hash=104&show=decided');
    expect(title()).toContain('Sample 104');
    expect(host.textContent).toContain('Outside filter');
    expect(
      useCompendiumQueueStore.getState().model.items.find((item) => item.type === 'row'),
    ).toMatchObject({ pinned: true });
  });

  it('shows the empty states', async () => {
    await mount('/compendium?q=nothing-matches-this');
    expect(host.textContent).toContain('Nothing matches');
    expect(host.querySelector('[aria-label="Review actions"]')).toBeNull();
  });

  it('narrows stepping to the active filter', async () => {
    await mount('/compendium?q=10');
    expect(useCompendiumQueueStore.getState().model.steps.map((row) => row.hash)).toEqual([
      100, 101, 102, 103, 104, 105,
    ]);
    await mount('/compendium?q=103');
    expect(useCompendiumQueueStore.getState().model.steps.map((row) => row.hash)).toEqual([103]);
    await press('ArrowDown');
    expect(title()).toContain('Sample 103');
  });

  it('leaves the editor-facing data untouched when only skipping', async () => {
    await mount();
    const tooltips = fixture.editor.bundle.tooltips;
    const before = JSON.stringify(tooltips);
    await press('s');
    expect(JSON.stringify(tooltips)).toBe(before);
  });
});
