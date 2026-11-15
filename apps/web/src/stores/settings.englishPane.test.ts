// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createSettingsStore, deviceKey, type SettingsStorage } from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage) =>
  createSettingsStore({
    storage,
    api: fakeServer().api,
    syncEnabled: true,
    now: () => '2026-11-14T10:00:00Z',
  });
const rememberedOf = (remembered: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ remembered }) }).storage).getState().device
    .remembered;

it("keeps the translate-mode English pane's version and Raw picks on this device, never synced", () => {
  const { storage, values } = memoryStorage();
  const store = make(storage);
  store.getState().remember({ englishVersion: 'base', englishRaw: true });
  expect(JSON.parse(values.get(deviceKey)!).remembered).toMatchObject({
    englishVersion: 'base',
    englishRaw: true,
  });
  expect(store.getState().pending).toEqual([]);
  // A reload reads both back.
  expect(make(storage).getState().device.remembered).toMatchObject({
    englishVersion: 'base',
    englishRaw: true,
  });
  for (const bad of ['raw', 3, null, {}])
    expect(rememberedOf({ englishVersion: bad, englishRaw: bad })).toEqual({});
  expect(rememberedOf({ englishVersion: 'compare' }).englishVersion).toBe('compare');
});
