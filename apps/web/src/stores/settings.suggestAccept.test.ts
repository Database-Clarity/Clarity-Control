// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createSettingsStore, deviceKey, settingsKey, type SettingsStorage } from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage) =>
  createSettingsStore({
    storage,
    api: fakeServer().api,
    syncEnabled: true,
    now: () => '2026-11-03T10:00:00Z',
  });
const acceptOf = (raw: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ suggestAccept: raw }) }).storage).getState()
    .settings.suggestAccept;

describe('account suggestion-chip accept key', () => {
  it('defaults to Enter', () => {
    expect(make(memoryStorage().storage).getState().settings.suggestAccept).toBe('enter');
  });

  it('keeps a stored Tab and recovers from anything else field by field', () => {
    expect(acceptOf('tab')).toBe('tab');
    expect(acceptOf('enter')).toBe('enter');
    for (const bad of [undefined, null, 'space', 3, {}, []]) expect(acceptOf(bad)).toBe('enter');
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify({ theme: 'light', suggestAccept: 'x', compendiumScale: 80 }),
    });
    expect(make(storage).getState().device).toMatchObject({
      theme: 'light',
      compendiumScale: 80,
    });
  });

  it('is saved locally in the synced copy', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().update({ suggestAccept: 'tab' });
    expect(JSON.parse(values.get(settingsKey('anonymous'))!).settings.suggestAccept).toBe('tab');
    expect('suggestAccept' in store.getState().device).toBe(false);
  });

  it('is not changed by resetting the pane widths', () => {
    const store = make(memoryStorage().storage);
    store.getState().update({ suggestAccept: 'tab' });
    store.getState().resetPaneWidths();
    expect(store.getState().settings.suggestAccept).toBe('tab');
  });
});
