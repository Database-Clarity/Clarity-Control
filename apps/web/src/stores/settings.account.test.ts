// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { defaultSyncedSettings, syncedSettingsSchema } from '@clarity/core';
import { createSettingsStore, deviceKey, settingsKey } from './settings';
import { fakeServer, memoryStorage } from './settings.testSupport';

const editor = { id: 7, role: 'editor' };
const moved = {
  editorFont: 'jetbrains-mono',
  suggestAccept: 'tab',
  symbolReveal: 'caret',
  finderWheel: 'groups',
  worklistStepping: false,
} as const;
const old = {
  dateFormat: 'iso',
  timeDisplay: 'datetime',
  timeZone: 'UTC',
  markupToolbar: 'open',
  englishSource: 'current',
} as const;
const stored = (settings: unknown) =>
  JSON.stringify({ settings, revision: 'r1', pending: [], pendingSince: null });
const make = (
  storage: ReturnType<typeof memoryStorage>['storage'],
  server = fakeServer(),
  syncEnabled = true,
) => createSettingsStore({ storage, api: server.api, syncEnabled });

describe('account editor preferences', () => {
  it('fills new defaults for old payloads, round-trips new payloads, and rejects unknown or invalid keys', () => {
    expect(syncedSettingsSchema.parse(old)).toEqual({ ...defaultSyncedSettings, ...old });
    const settings = { ...defaultSyncedSettings, ...moved };
    expect(syncedSettingsSchema.parse(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(syncedSettingsSchema.safeParse({ ...settings, extra: true }).success).toBe(false);
    expect(syncedSettingsSchema.safeParse({ ...settings, worklistStepping: 'off' }).success).toBe(
      false,
    );
  });

  for (const action of ['useRemote', 'keepLocal'] as const) {
    it(`seeds the existing scope once, offers a choice, and persists ${action}`, async () => {
      const { storage, values } = memoryStorage({
        [deviceKey]: JSON.stringify({ ...moved, editorFontSize: 18, uiScale: 120 }),
        [settingsKey('7')]: stored(old),
      });
      const server = fakeServer({
        settings: { ...defaultSyncedSettings, ...old, dateFormat: 'dmy' },
        revision: 'r1',
      });
      const store = make(storage, server);
      await store.getState().activate(editor);
      expect(store.getState().settings).toMatchObject(moved);
      expect(store.getState().status).toBe('choice');
      expect(server.calls.put).toHaveLength(0);
      expect(store.getState().choice?.local).toMatchObject(moved);
      await store.getState()[action]();
      const wanted = action === 'keepLocal' ? moved : server.remote.settings!;
      expect(store.getState().settings).toMatchObject(wanted);
      expect(store.getState().device).toMatchObject({ editorFontSize: 18, uiScale: 120 });
      expect(JSON.parse(values.get(settingsKey('7'))!).pending).toEqual([]);
      const again = make(storage, server);
      await again.getState().activate(editor);
      expect(again.getState().status).toBe('synced');
      expect(again.getState().settings).toMatchObject(wanted);
    });
  }

  it('keeps explicit account-local fields instead of re-seeding them from legacy device data', async () => {
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify(moved),
      [settingsKey('7')]: stored(defaultSyncedSettings),
    });
    const server = fakeServer({ settings: defaultSyncedSettings, revision: 'r1' });
    const store = make(storage, server);
    await store.getState().activate(editor);
    expect(store.getState().settings).toEqual(defaultSyncedSettings);
    expect(store.getState().choice).toBeNull();
  });

  it('retains legacy seeds for another existing account after a device-only write and reload', async () => {
    const { storage } = memoryStorage({
      [deviceKey]: JSON.stringify(moved),
      [settingsKey('8')]: stored(old),
    });
    const store = make(storage);
    store.getState().updateDevice({ theme: 'dark' });
    const again = make(storage);
    await again.getState().activate({ id: 8, role: null });
    expect(again.getState().settings).toMatchObject(moved);
  });

  for (const syncEnabled of [false, true]) {
    it(`persists all five locally while signed out, sync enabled=${syncEnabled}`, async () => {
      const { storage } = memoryStorage();
      const server = fakeServer();
      const store = make(storage, server, syncEnabled);
      store.getState().update(moved);
      await store.getState().leaveSettings();
      expect(server.calls.put).toHaveLength(0);
      expect(make(storage, server, syncEnabled).getState().settings).toMatchObject(moved);
      expect(store.getState().device).not.toHaveProperty('editorFont');
    });
  }

  it('syncs each change on Settings exit, reloads, reaches a second profile, and survives sign-out/in', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    await store.getState().activate(editor);
    store.getState().enterSettings();
    for (const [key, value] of Object.entries(moved)) store.getState().update({ [key]: value });
    expect(server.calls.put).toHaveLength(0);
    await store.getState().leaveSettings();
    expect(server.remote.settings).toMatchObject(moved);
    const again = make(storage, server);
    await again.getState().activate(editor);
    expect(again.getState().settings).toMatchObject(moved);
    const other = make(memoryStorage().storage, server);
    await other.getState().activate(editor);
    expect(other.getState().settings).toMatchObject(moved);
    await store.getState().activate(null);
    await store.getState().activate(editor);
    expect(store.getState().settings).toMatchObject(moved);
  });
});
