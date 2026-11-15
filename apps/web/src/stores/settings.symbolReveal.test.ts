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
const revealOf = (raw: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ symbolReveal: raw }) }).storage).getState()
    .settings.symbolReveal;

describe('account symbol reveal', () => {
  it('defaults to the popover', () => {
    expect(make(memoryStorage().storage).getState().settings.symbolReveal).toBe('popover');
  });

  it('keeps a stored caret and recovers from anything else field by field', () => {
    expect(revealOf('caret')).toBe('caret');
    expect(revealOf('popover')).toBe('popover');
    for (const bad of [undefined, null, 'hover', 3, {}, []]) expect(revealOf(bad)).toBe('popover');
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify({ theme: 'light', symbolReveal: 'x', compendiumScale: 80 }),
    });
    expect(make(storage).getState().device).toMatchObject({
      theme: 'light',
      compendiumScale: 80,
    });
  });

  it('is saved locally in the synced copy', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().update({ symbolReveal: 'caret' });
    expect(JSON.parse(values.get(settingsKey('anonymous'))!).settings.symbolReveal).toBe('caret');
    expect('symbolReveal' in store.getState().device).toBe(false);
  });
});
