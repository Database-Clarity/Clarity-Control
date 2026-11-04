// @vitest-environment jsdom
// The Compendium right pane: one 28px header (title, diff view, pick other row, zoom) over a
// scrolling body; the zoom is a device setting; the diff view moves above the diff in a narrow pane.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, Tooltip } from '@clarity/core';
import * as core from '@clarity/core';
import * as dates from '../../services/format/date';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsStore } from '../../stores/settings';
import { useCompendiumStore } from './store';
import { CompendiumPanel } from './CompendiumPanel';
import { usePaneMatch } from './usePaneMatch';
import { useDisplayMatches } from './useDisplayMatches';

vi.mock('./usePaneMatch', () => ({ usePaneMatch: vi.fn() }));
vi.mock('./useDisplayMatches', () => ({ useDisplayMatches: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../../services/api', () => ({ apiUrl: 'https://api.test' }));
vi.mock('./LinkPicker', () => ({
  LinkPicker: () => createElement('div', { 'data-picker': true }),
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
  vi.mocked(usePaneMatch).mockReturnValue(undefined);
  vi.mocked(useDisplayMatches).mockReturnValue({
    prepared: undefined,
    reviewPrepared: undefined,
    matches: undefined,
    decisions: undefined,
    loading: false,
    error: undefined,
  });
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
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  it('reuses the status row for a priority match without waiting for full catalog metadata', async () => {
    const base = { hash: 6, text: {}, associated: [] } as unknown as Tooltip;
    const initial = vi.mocked(useDisplayMatches).getMockImplementation()!;
    vi.mocked(useDisplayMatches).mockImplementation((...args) => ({
      ...initial(...args),
      loading: true,
    }));
    const host = await mount(base);
    const status = host.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('Matching Compendium…');
    expect(vi.mocked(useDisplayMatches).mock.calls.at(-1)?.[4]).toBe(base.hash);
    vi.mocked(usePaneMatch).mockReturnValue({ status: 'ok', changed: false, tab, row });
    // The pane must also tolerate a late loading subscriber: the match is authoritative.
    await act(async () => useDraftStore.setState({ drafts: { 6: { base, next: base } } }));
    expect(host.contains(status)).toBe(true);
    expect(status.textContent).toContain('Matched');
    expect(status.getAttribute('role')).toBeNull();
    expect(host.textContent).not.toContain('Matching Compendium…');
    const cell = host.querySelector('[data-multiline]');
    vi.mocked(useDisplayMatches).mockImplementation(initial);
    await act(async () => useDraftStore.setState({ drafts: {} }));
    expect(host.contains(status)).toBe(true);
    expect(host.querySelector('[data-multiline]')).toBe(cell);
  });

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
    const initial = vi.mocked(useDisplayMatches).getMockImplementation()!;
    vi.mocked(useDisplayMatches).mockImplementation((...args) => ({
      ...initial(...args),
      loading: true,
    }));
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
    vi.mocked(usePaneMatch).mockReturnValue({ status: 'ok', changed: false, tab, row });
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
    vi.mocked(usePaneMatch).mockReturnValue({ status: 'ok', changed: false, tab, row });
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
