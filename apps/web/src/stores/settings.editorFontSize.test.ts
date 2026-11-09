// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  appliedUiScale,
  createSettingsStore,
  deviceKey,
  editorFontSizes,
  normalizeEditorFontSize,
  type SettingsStorage,
} from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage) =>
  createSettingsStore({
    storage,
    api: fakeServer().api,
    syncEnabled: true,
    now: () => '2026-11-09T10:00:00Z',
  });
const root = document.documentElement;
const stored = (values: Map<string, string>) => JSON.parse(values.get(deviceKey)!);

afterEach(() => {
  root.style.removeProperty('font-size');
  root.style.removeProperty('--editor-font-size');
  delete root.dataset.uiScale;
});

describe('editor text size device preference', () => {
  it('defaults to automatic (today’s size) when missing, corrupt or not a number', () => {
    expect(make(memoryStorage().storage).getState().device.editorFontSize).toBeNull();
    for (const editorFontSize of ['big', {}, NaN, null, true]) {
      const { storage } = memoryStorage({ [deviceKey]: JSON.stringify({ editorFontSize }) });
      expect(make(storage).getState().device.editorFontSize).toBeNull();
    }
  });

  it('snaps a stored size to the nearest offered size', () => {
    expect(normalizeEditorFontSize(17)).toBe(16);
    expect(normalizeEditorFontSize(200)).toBe(24);
    expect(normalizeEditorFontSize(1)).toBe(11);
    expect(editorFontSizes).toContain(normalizeEditorFontSize(14));
  });

  it('applies --editor-font-size in pixels, persists per device, and clears on automatic', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('');
    store.getState().updateDevice({ editorFontSize: 18 });
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('18px');
    expect(stored(values).editorFontSize).toBe(18);
    expect(store.getState().pending).toEqual([]);
    // Reload on the same device keeps it; nothing reaches the synced copy.
    expect(make(storage).getState().device.editorFontSize).toBe(18);
    expect([...values.keys()].filter((key) => key !== deviceKey)).toEqual([]);
    store.getState().updateDevice({ editorFontSize: null });
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('');
  });

  it('is independent of the interface scale', () => {
    const { storage } = memoryStorage();
    const store = make(storage);
    store.getState().updateDevice({ editorFontSize: 16 });
    store.getState().updateDevice({ uiScale: 150 });
    expect(store.getState().device.editorFontSize).toBe(16);
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('16px');
    expect(root.style.fontSize).toBe(`${appliedUiScale(150, window.innerWidth)}%`);
    store.getState().updateDevice({ uiScale: 100 });
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('16px');
    expect(store.getState().device.uiScale).toBe(100);
  });
});
