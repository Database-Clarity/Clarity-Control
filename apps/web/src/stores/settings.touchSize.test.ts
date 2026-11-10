// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyDeviceSettings,
  createSettingsStore,
  deviceKey,
  type SettingsStorage,
} from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const make = (storage: SettingsStorage, server = fakeServer()) =>
  createSettingsStore({
    storage,
    api: server.api,
    syncEnabled: true,
    now: () => '2026-11-10T10:00:00Z',
  });
const sizeOf = (raw: unknown) =>
  make(memoryStorage({ [deviceKey]: JSON.stringify({ touchSize: raw }) }).storage).getState().device
    .touchSize;

describe('device touch control size', () => {
  it('defaults to compact and keeps a stored large; anything else is compact', () => {
    expect(make(memoryStorage().storage).getState().device.touchSize).toBe('compact');
    expect(sizeOf('large')).toBe('large');
    for (const bad of [undefined, null, 'huge', 44, {}, []]) expect(sizeOf(bad)).toBe('compact');
  });

  it('is saved on this device only: never in the synced copy, never sent, never pending', async () => {
    const { storage, values } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    store.getState().updateDevice({ touchSize: 'large' });
    expect(JSON.parse(values.get(deviceKey)!).touchSize).toBe('large');
    expect('touchSize' in store.getState().settings).toBe(false);
    expect(store.getState().pending).toEqual([]);
    await store.getState().sync();
    expect(JSON.stringify(server.calls.put)).not.toContain('touchSize');
  });

  it('is written to the root as data-touch, which the touch size tokens read', () => {
    const device = make(memoryStorage().storage).getState().device;
    applyDeviceSettings({ ...device, touchSize: 'large' });
    expect(document.documentElement.dataset.touch).toBe('large');
    applyDeviceSettings({ ...device, touchSize: 'compact' });
    expect(document.documentElement.dataset.touch).toBe('compact');
  });
});
