// @vitest-environment jsdom
// The Compendium right pane: one 28px header (title, diff view, pick other row, zoom) over a
// scrolling body; the zoom is a device setting; the diff view moves above the diff in a narrow pane.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, Tooltip } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsStore } from '../../stores/settings';
import { useCompendiumStore } from './store';
import { CompendiumPanel } from './CompendiumPanel';

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
    constructor(private notify: () => void) {}
    observe() {
      this.notify();
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
});
