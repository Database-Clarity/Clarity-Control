// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSyncedSettings } from '@clarity/core';
import {
  appliedUiScale,
  createSettingsStore,
  deviceKey,
  layoutKey,
  type SettingsStorage,
} from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage) =>
  createSettingsStore({
    storage,
    api: fakeServer().api,
    syncEnabled: true,
    now: () => '2026-11-03T10:00:00Z',
  });
const stored = (values: Map<string, string>) => JSON.parse(values.get(deviceKey)!);

afterEach(() => {
  document.documentElement.style.removeProperty('font-size');
  delete document.documentElement.dataset.uiScale;
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

describe('device theme', () => {
  it('defaults to system when storage is missing, corrupt or holds an unknown value', () => {
    expect(make(memoryStorage().storage).getState().device.theme).toBe('system');
    expect(make(memoryStorage({ [deviceKey]: '{not json' }).storage).getState().device.theme).toBe(
      'system',
    );
    for (const theme of ['sepia', 3, null, {}]) {
      const { storage } = memoryStorage({ [deviceKey]: JSON.stringify({ theme }) });
      expect(make(storage).getState().device.theme).toBe('system');
    }
  });

  it('persists a choice on this device only and survives reload', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().updateDevice({ theme: 'light' });
    expect(stored(values).theme).toBe('light');
    expect(store.getState().pending).toEqual([]);
    expect(make(storage).getState().device.theme).toBe('light');
    // The synced copy never learns about it.
    expect([...values.keys()].filter((key) => key !== deviceKey)).toEqual([]);
  });

  it('applies the resolved theme to the document, an explicit choice winning over the system', () => {
    const store = make(memoryStorage().storage);
    store.getState().updateDevice({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    store.getState().updateDevice({ theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    store.getState().updateDevice({ theme: 'system' });
    expect(document.documentElement.dataset.theme).toBe('dark'); // no matchMedia: app default
  });

  it('survives denied storage: the choice applies for this visit and a notice explains', () => {
    const { storage } = memoryStorage();
    const denied: SettingsStorage = {
      ...storage,
      set() {
        throw new Error('QuotaExceededError');
      },
    };
    const store = make(denied);
    store.getState().updateDevice({ theme: 'light' });
    expect(store.getState().device.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(store.getState().notice).toContain('cannot be saved');
  });

  it('keeps valid old device fields when only the new ones are invalid', () => {
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify({
        uiScale: 130,
        editorFont: 'fira-code',
        remembered: { markupToolbar: 'open' },
        theme: 'neon',
        panes: 7,
      }),
    });
    expect(make(storage).getState().device).toEqual({
      uiScale: 130,
      editorFont: 'fira-code',
      editorFontSize: null,
      theme: 'system',
      panes: {},
      compendiumScale: 100,
      suggestAccept: 'enter',
      symbolReveal: 'popover',
      remembered: { markupToolbar: 'open' },
    });
  });
});

describe('device panes', () => {
  const pane = { width: 400, collapsed: false };

  it('validates entry by entry: bad keys, widths and flags drop only their own pane', () => {
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify({
        panes: {
          'editor:left': { width: 360, collapsed: true, lastExpanded: 336 },
          'review:list': { width: 300 },
          'bad key': pane,
          'editor:right': { width: Number.POSITIVE_INFINITY, collapsed: false },
          'compendium:main': { width: -5, collapsed: false },
          'batch:list': { width: 'wide', collapsed: false },
          'worklist:list': null,
          'editor:odd': { width: 320, collapsed: 'yes', lastExpanded: 'big' },
        },
      }),
    });
    expect(make(storage).getState().device.panes).toEqual({
      'editor:left': { width: 360, collapsed: true, lastExpanded: 336 },
      'review:list': { width: 300, collapsed: false },
      'editor:odd': { width: 320, collapsed: false },
    });
  });

  it('resets every pane key and the legacy split without touching theme, font or synced settings', () => {
    const { storage, values } = memoryStorage({ [layoutKey]: '70' });
    const store = make(storage);
    store.getState().update({ dateFormat: 'iso' });
    store.getState().updateDevice({
      theme: 'light',
      editorFont: 'fira-code',
      panes: { 'editor:left': pane, 'review:list': pane },
      compendiumScale: 70,
    });
    const before = store.getState().paneResets;
    expect(store.getState().resetPaneWidths()).toBe(true);
    expect(store.getState().device).toMatchObject({
      theme: 'light',
      editorFont: 'fira-code',
      panes: {},
      compendiumScale: 100,
    });
    expect(stored(values).panes).toEqual({});
    expect(values.has(layoutKey)).toBe(false);
    expect(store.getState().paneResets).toBe(before + 1);
    expect(store.getState().settings).toEqual({ ...defaultSyncedSettings, dateFormat: 'iso' });
    expect(store.getState().notice).toBe('');
  });

  it('saves and forgets one pane at a time, ignoring bad keys, and keeps it across a reload', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().setPane('editor:left', { width: 352, collapsed: false });
    store.getState().setPane('editor:right', { width: 400, collapsed: true, lastExpanded: 384 });
    store.getState().setPane('Not A Key', { width: 1, collapsed: false });
    expect(Object.keys(store.getState().device.panes).sort()).toEqual([
      'editor:left',
      'editor:right',
    ]);
    expect(make(storage).getState().device.panes['editor:left']).toEqual({
      width: 352,
      collapsed: false,
    });
    store.getState().setPane('editor:left', null);
    expect(Object.keys(stored(values).panes)).toEqual(['editor:right']);
    expect(store.getState().device.theme).toBe('system');
  });

  it('reports failure, with a notice, when storage refuses the reset', () => {
    const { storage } = memoryStorage({ [layoutKey]: '70' });
    const denied: SettingsStorage = {
      ...storage,
      remove() {
        throw new Error('SecurityError');
      },
    };
    const store = make(denied);
    store.getState().updateDevice({ panes: { 'editor:left': pane } });
    expect(store.getState().resetPaneWidths()).toBe(false);
    expect(store.getState().notice).toContain('Cannot reset pane widths');
    expect(store.getState().device.panes).toEqual({}); // mounted panes still snap back
  });

  it('never sends pane widths to the account', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    const store = createSettingsStore({ storage, api: server.api, syncEnabled: true });
    await store.getState().activate({ id: 7, role: 'editor' });
    store.getState().updateDevice({ panes: { 'editor:left': pane } });
    await store.getState().leaveSettings();
    expect(server.calls.put).toHaveLength(0);
  });
});

describe('interface scale on the page', () => {
  it('limits a large scale where it would squeeze a tablet-width window into the phone layout', () => {
    expect(appliedUiScale(150, 1280)).toBe(150);
    expect(appliedUiScale(150, 768)).toBe(108);
    expect(appliedUiScale(150, 701)).toBe(100);
    expect(appliedUiScale(150, 390)).toBe(150);
    expect(appliedUiScale(150, 320)).toBe(123);
    expect(appliedUiScale(85, 320)).toBe(85);
    expect(appliedUiScale(100, 320)).toBe(100);
  });

  it('sets the root font size and removes it again at 100 %', () => {
    const store = make(memoryStorage().storage);
    store.getState().updateDevice({ uiScale: 85 });
    expect(document.documentElement.style.fontSize).toBe('85%');
    store.getState().updateDevice({ uiScale: 100 });
    expect(document.documentElement.style.fontSize).toBe('');
  });
});
