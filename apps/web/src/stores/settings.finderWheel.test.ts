// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createSettingsStore, deviceKey, settingsKey, type SettingsStorage } from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage) =>
  createSettingsStore({
    storage,
    api: fakeServer().api,
    syncEnabled: true,
    now: () => '2026-11-09T10:00:00Z',
  });
const wheelOf = (raw: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ finderWheel: raw }) }).storage).getState()
    .settings.finderWheel;

describe('account finder wheel', () => {
  it('defaults to Shift stepping entries', () => {
    expect(make(memoryStorage().storage).getState().settings.finderWheel).toBe('entries');
  });

  it('keeps a stored swap and recovers from anything else field by field', () => {
    expect(wheelOf('groups')).toBe('groups');
    expect(wheelOf('entries')).toBe('entries');
    for (const bad of [undefined, null, 'alt', 1, {}, []]) expect(wheelOf(bad)).toBe('entries');
  });

  it('is saved locally in the synced copy', () => {
    const { storage, values } = memoryStorage();
    const store = make(storage);
    store.getState().update({ finderWheel: 'groups' });
    expect(JSON.parse(values.get(settingsKey('anonymous'))!).settings.finderWheel).toBe('groups');
    expect('finderWheel' in store.getState().device).toBe(false);
  });
});
