// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  compendiumScales,
  createSettingsStore,
  defaultCompendiumScale,
  deviceKey,
  normalizeCompendiumScale,
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
const scaleOf = (raw: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ compendiumScale: raw }) }).storage).getState()
    .device.compendiumScale;

describe('device Compendium scale', () => {
  it('is 70 to 100 in steps of 10, defaulting to the natural size', () => {
    expect([...compendiumScales]).toEqual([70, 80, 90, 100]);
    expect(defaultCompendiumScale).toBe(100);
    expect(make(memoryStorage().storage).getState().device.compendiumScale).toBe(100);
  });

  it('recovers field by field from a missing, corrupt or out-of-range value', () => {
    for (const bad of [undefined, null, 'big', {}, [], true, Number.NaN])
      expect(scaleOf(bad)).toBe(100);
    expect(
      make(memoryStorage({ [deviceKey]: '{not json' }).storage).getState().device,
    ).toMatchObject({ compendiumScale: 100, theme: 'system' });
    expect(scaleOf(10)).toBe(70);
    expect(scaleOf(-5)).toBe(70);
    expect(scaleOf(500)).toBe(100);
    expect(scaleOf(Number.POSITIVE_INFINITY)).toBe(100);
    expect(scaleOf(84)).toBe(80);
    expect(scaleOf(85)).toBe(90);
    expect(normalizeCompendiumScale(90)).toBe(90);
  });

  it('keeps the other device fields when only the scale is invalid', () => {
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify({
        theme: 'light',
        editorFont: 'fira-code',
        compendiumScale: 'x',
      }),
    });
    expect(make(storage).getState().device).toMatchObject({
      theme: 'light',
      editorFont: 'fira-code',
      compendiumScale: 100,
    });
  });

  it('saves on this device only, survives a reload, and resets with the pane widths', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().updateDevice({ compendiumScale: 80 });
    expect(JSON.parse(values.get(deviceKey)!).compendiumScale).toBe(80);
    expect(store.getState().pending).toEqual([]);
    expect(make(storage).getState().device.compendiumScale).toBe(80);
    expect(store.getState().resetPaneWidths()).toBe(true);
    expect(store.getState().device.compendiumScale).toBe(100);
    expect(JSON.parse(values.get(deviceKey)!).compendiumScale).toBe(100);
    expect(make(storage).getState().device.compendiumScale).toBe(100);
  });
});
