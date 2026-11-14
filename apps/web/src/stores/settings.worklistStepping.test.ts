// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createSettingsStore, deviceKey, settingsKey, type SettingsStorage } from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage) =>
  createSettingsStore({
    storage,
    api: fakeServer().api,
    syncEnabled: true,
    now: () => '2026-11-14T10:00:00Z',
  });
const steppingOf = (raw: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ worklistStepping: raw }) }).storage).getState()
    .settings.worklistStepping;

describe('account worklist stepping', () => {
  it('is on by default', () => {
    expect(make(memoryStorage().storage).getState().settings.worklistStepping).toBe(true);
  });

  it('keeps a stored choice and recovers from anything else field by field', () => {
    expect(steppingOf(false)).toBe(false);
    expect(steppingOf(true)).toBe(true);
    for (const bad of [undefined, null, 'off', 0, {}, []]) expect(steppingOf(bad)).toBe(true);
  });

  it('is saved locally in the synced copy', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().update({ worklistStepping: false });
    expect(JSON.parse(values.get(settingsKey('anonymous'))!).settings.worklistStepping).toBe(false);
    expect('worklistStepping' in store.getState().device).toBe(false);
    expect(make(storage).getState().settings.worklistStepping).toBe(false);
  });
});
