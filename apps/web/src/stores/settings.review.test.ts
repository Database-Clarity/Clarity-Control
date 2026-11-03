import { expect, it } from 'vitest';
import { defaultSyncedSettings } from '@clarity/core';
import { createSettingsStore, settingsKey } from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

it('does not let an old recovery choice erase a newer synced value and another tab pending edit', async () => {
  const { storage, values } = memoryStorage();
  const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
  const make = () => createSettingsStore({ storage, api: server.api, syncEnabled: true });
  const a = make();
  await a.getState().activate({ id: 7, role: 'editor' });
  a.getState().update({ dateFormat: 'iso' });
  const b = make();
  await b.getState().activate({ id: 7, role: 'editor' });
  expect(b.getState().choice?.remote.revision).toBe('r1');
  await a.getState().sync();
  a.getState().update({ timeZone: 'UTC' });
  // Both writes can precede B processing storage events. useRemote reconciles itself.
  b.getState().useRemote();
  expect(JSON.parse(values.get(settingsKey('7'))!)).toMatchObject({
    settings: { dateFormat: 'iso', timeZone: 'UTC' },
    pending: ['timeZone'],
    revision: server.remote.revision,
  });
});

for (const action of ['useRemote', 'keepLocal'] as const) {
  it(`${action} invalidates an obsolete choice without sending or losing newer pending fields`, async () => {
    const { storage, values } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const make = () => createSettingsStore({ storage, api: server.api, syncEnabled: true });
    const a = make();
    await a.getState().activate({ id: 7, role: 'editor' });
    a.getState().update({ dateFormat: 'iso' });
    const b = make();
    await b.getState().activate({ id: 7, role: 'editor' });
    await a.getState().sync();
    a.getState().update({ timeZone: 'UTC' });
    const before = values.get(settingsKey('7'));
    await b.getState()[action]();
    expect(b.getState().choice).toBeNull();
    expect(values.get(settingsKey('7'))).toBe(before);
    expect(server.calls.put).toHaveLength(1);
  });

  for (const editInChoiceTab of [false, true]) {
    it(`${action} preserves edits after the choice in ${editInChoiceTab ? 'this' : 'another'} tab`, async () => {
      const { storage, values } = memoryStorage();
      const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
      const make = () => createSettingsStore({ storage, api: server.api, syncEnabled: true });
      const a = make();
      await a.getState().activate({ id: 7, role: 'editor' });
      a.getState().update({ dateFormat: 'iso' });
      const b = make();
      await b.getState().activate({ id: 7, role: 'editor' });
      (editInChoiceTab ? b : a).getState().update({ timeZone: 'UTC', dateFormat: 'dmy' });
      await b.getState()[action]();
      expect(JSON.parse(values.get(settingsKey('7'))!)).toMatchObject({
        settings: { dateFormat: 'dmy', timeZone: 'UTC' },
        pending: action === 'useRemote' ? ['dateFormat', 'timeZone'] : [],
      });
      if (action === 'useRemote') {
        expect(b.getState().pendingSince).not.toBeNull();
        const reloaded = make();
        await reloaded.getState().activate({ id: 7, role: 'editor' });
        expect(reloaded.getState().choice?.recovered).toBe(true);
      }
    });
  }
}

it('does not persist an old PUT response over a newer tab acknowledgement', async () => {
  const { storage, values } = memoryStorage();
  const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
  let release!: () => void;
  const a = createSettingsStore({
    storage,
    syncEnabled: true,
    api: {
      ...server.api,
      async put(...args) {
        const response = await server.api.put(...args);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return response;
      },
    },
  });
  await a.getState().activate({ id: 7, role: 'editor' });
  a.getState().update({ dateFormat: 'iso' });
  const sending = a.getState().sync();
  await Promise.resolve();
  const b = createSettingsStore({ storage, api: server.api, syncEnabled: true });
  await b.getState().activate({ id: 7, role: 'editor' });
  b.getState().update({ timeZone: 'UTC' });
  await b.getState().sync();
  b.getState().update({ dateFormat: 'dmy' });
  const before = values.get(settingsKey('7'));
  release();
  await sending;
  expect(values.get(settingsKey('7'))).toBe(before);
  expect(a.getState()).toMatchObject({
    revision: server.remote.revision,
    pending: ['dateFormat'],
    settings: { dateFormat: 'dmy', timeZone: 'UTC' },
  });
});
