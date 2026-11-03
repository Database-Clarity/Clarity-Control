import { describe, expect, it } from 'vitest';
import { fakeServer, memoryStorage } from './settings.testSupport';
import { defaultSyncedSettings } from '@clarity/core';
import {
  createSettingsStore,
  deviceKey,
  legacySourceKey,
  legacyToolbarKey,
  settingsKey,
  type SettingsStorage,
} from './settings';

const editor = { id: 7, role: 'editor' };
const make = (storage: SettingsStorage, server: ReturnType<typeof fakeServer>) =>
  createSettingsStore({
    storage,
    api: server.api,
    syncEnabled: true,
    now: () => '2026-11-02T10:00:00Z',
  });

describe('settings store: local storage', () => {
  it('migrates the two old preference keys once and deletes them', () => {
    const { values, storage } = memoryStorage({
      [legacyToolbarKey]: 'open',
      [legacySourceKey]: 'current',
    });
    const store = make(storage, fakeServer());
    expect(store.getState().settings).toMatchObject({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    // The old keys were this device's last clicks: they also become its remembered choices.
    expect(store.getState().device.remembered).toEqual({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    expect(values.has(legacyToolbarKey)).toBe(false);
    expect(values.has(legacySourceKey)).toBe(false);
    expect(JSON.parse(values.get(settingsKey('anonymous'))!).settings.markupToolbar).toBe('open');
    // A second load keeps the migrated values from the new keys.
    const again = make(storage, fakeServer()).getState();
    expect(again.settings.englishSource).toBe('current');
    expect(again.device.remembered.markupToolbar).toBe('open');
  });

  it('falls back to defaults with a visible notice on corrupted data, field by field', () => {
    const broken = make(
      memoryStorage({ [settingsKey('anonymous')]: '{oops' }).storage,
      fakeServer(),
    );
    expect(broken.getState().settings).toEqual(defaultSyncedSettings);
    expect(broken.getState().notice).toMatch(/could not be read/);
    const partial = make(
      memoryStorage({
        [settingsKey('anonymous')]: JSON.stringify({
          settings: { dateFormat: 'iso', timeZone: 'Mars/Base', extra: 1 },
        }),
      }).storage,
      fakeServer(),
    );
    expect(partial.getState().settings).toEqual({ ...defaultSyncedSettings, dateFormat: 'iso' });
  });

  it('keeps device settings apart: never in the synced copy, never sent, never pending', async () => {
    const { values, storage } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    await store.getState().activate(editor);
    store.getState().updateDevice({ textSize: 'large' });
    expect(JSON.parse(values.get(deviceKey)!)).toEqual({
      textSize: 'large',
      editorFont: 'default',
      theme: 'system',
      panes: {},
      remembered: {},
    });
    expect(values.get(settingsKey('7'))).not.toContain('textSize');
    expect(store.getState().pending).toEqual([]);
    await store.getState().sync();
    expect(server.calls.put).toHaveLength(0);
    // Device settings survive a user switch and a reload.
    await store.getState().activate(null);
    expect(make(storage, fakeServer()).getState().device.textSize).toBe('large');
  });

  it('adopts the signed-out copy once on sign-in and never shares between users', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    store.getState().update({ dateFormat: 'iso' });
    await store.getState().activate(editor);
    expect(store.getState().settings.dateFormat).toBe('iso');
    expect(store.getState().pending).toEqual([]);
    store.getState().update({ dateFormat: 'mdy' });
    await store.getState().activate({ id: 8, role: null });
    expect(store.getState().settings.dateFormat).toBe('iso');
    expect(store.getState().status).toBe('device');
    expect(store.getState().reason).toBe('no-role');
    await store.getState().activate(editor);
    expect(store.getState().settings.dateFormat).toBe('mdy');
  });
});

describe('settings store: remembered editor toggles', () => {
  it('remembers clicks per device: never pending, never synced, never prompted after a reload', async () => {
    const { values, storage } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    await store.getState().activate(editor);
    store.getState().remember({ markupToolbar: 'open' });
    store.getState().remember({ englishSource: 'current' });
    expect(store.getState()).toMatchObject({ pending: [], status: 'synced' });
    expect(store.getState().settings).toEqual(defaultSyncedSettings);
    expect(JSON.parse(values.get(deviceKey)!).remembered).toEqual({
      markupToolbar: 'open',
      englishSource: 'current',
    });
    await store.getState().sync();
    store.getState().syncOnHide();
    await Promise.resolve();
    expect(server.calls.put).toHaveLength(0);
    const reloaded = make(storage, server);
    await reloaded.getState().activate(editor);
    expect(reloaded.getState()).toMatchObject({ status: 'synced', choice: null });
    expect(reloaded.getState().device.remembered.markupToolbar).toBe('open');
    // Another device (fresh storage) starts from the synced default instead.
    expect(make(memoryStorage().storage, server).getState().device.remembered).toEqual({});
  });
});

describe('settings store: sync', () => {
  it('applies changes at once but does not sync until asked (Settings exit)', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().update({ timeDisplay: 'relative' });
    store.getState().update({ timeZone: 'Europe/Berlin' });
    expect(store.getState().settings).toMatchObject({
      timeDisplay: 'relative',
      timeZone: 'Europe/Berlin',
    });
    expect(store.getState().status).toBe('unsynced');
    expect(server.calls.put).toHaveLength(0);
    await store.getState().sync();
    expect(server.calls.put).toHaveLength(1);
    expect(server.remote.settings).toMatchObject({ timeDisplay: 'relative' });
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [], pendingSince: null });
    await store.getState().sync();
    expect(server.calls.put).toHaveLength(1);
  });

  it('syncs edits made while the account copy was loading once it arrives, if Settings was left', async () => {
    const server = fakeServer();
    server.set({ ...defaultSyncedSettings, dateFormat: 'mdy' });
    const store = make(memoryStorage().storage, server);
    const loading = store.getState().activate(editor);
    store.getState().update({ timeZone: 'UTC' });
    await store.getState().sync();
    await loading;
    // One PUT, based on the loaded revision, carrying the account copy plus the edit.
    expect(server.calls.put).toHaveLength(1);
    expect(server.remote.settings).toMatchObject({ dateFormat: 'mdy', timeZone: 'UTC' });
    expect(store.getState().status).toBe('synced');
  });

  it('adopts the account copy on sign-in when nothing is pending', async () => {
    const server = fakeServer();
    server.set({ ...defaultSyncedSettings, dateFormat: 'mdy' });
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    expect(store.getState()).toMatchObject({ status: 'synced', choice: null });
    expect(store.getState().settings.dateFormat).toBe('mdy');
  });

  it('keeps pending changes and offers a retry when the sync fails', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().update({ dateFormat: 'iso' });
    server.fail('network down');
    await store.getState().sync();
    expect(store.getState()).toMatchObject({
      status: 'error',
      error: 'network down',
      pending: ['dateFormat'],
    });
    server.fail('');
    await store.getState().retry();
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [] });
  });

  it('asks after a reload with unsynced changes and never overwrites silently', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    const first = make(storage, server);
    await first.getState().activate(editor);
    first.getState().update({ dateFormat: 'iso', markupToolbar: 'open' });
    // The tab closes without leaving Settings: no sync, a pending marker on disk.
    const reloaded = make(storage, server);
    await reloaded.getState().activate(editor);
    expect(reloaded.getState().status).toBe('choice');
    expect(reloaded.getState().choice).toMatchObject({
      recovered: true,
      since: '2026-11-02T10:00:00Z',
      local: { dateFormat: 'iso', markupToolbar: 'open' },
      remote: { settings: null },
    });
    // Local changes stay applied while the user decides; nothing was sent.
    expect(reloaded.getState().settings.dateFormat).toBe('iso');
    expect(server.calls.put).toHaveLength(0);
    await reloaded.getState().sync();
    reloaded.getState().syncOnHide();
    expect(server.calls.put).toHaveLength(0);
    await reloaded.getState().keepLocal();
    expect(server.calls.put).toHaveLength(1);
    expect(server.remote.settings).toMatchObject({ dateFormat: 'iso', markupToolbar: 'open' });
    expect(reloaded.getState()).toMatchObject({ status: 'synced', choice: null, pending: [] });
    // And the next load is quiet.
    const again = make(storage, server);
    await again.getState().activate(editor);
    expect(again.getState()).toMatchObject({ status: 'synced', choice: null });
  });

  it('discards recovered changes in favour of the synced copy on request', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    server.set({ ...defaultSyncedSettings, dateFormat: 'mdy' });
    const first = make(storage, server);
    await first.getState().activate(editor);
    first.getState().update({ dateFormat: 'iso' });
    const reloaded = make(storage, server);
    await reloaded.getState().activate(editor);
    expect(reloaded.getState().choice?.remote.settings?.dateFormat).toBe('mdy');
    reloaded.getState().useRemote();
    expect(reloaded.getState()).toMatchObject({ status: 'synced', pending: [], choice: null });
    expect(reloaded.getState().settings.dateFormat).toBe('mdy');
    expect(server.calls.put).toHaveLength(0);
    const again = make(storage, server);
    await again.getState().activate(editor);
    expect(again.getState().choice).toBeNull();
  });

  it('clears a recovered marker quietly when the account already has the same values', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    const first = make(storage, server);
    await first.getState().activate(editor);
    first.getState().update({ dateFormat: 'iso' });
    // A best-effort keepalive sync reached the server, but the page died before the reply.
    server.set({ ...defaultSyncedSettings, dateFormat: 'iso' });
    const reloaded = make(storage, server);
    await reloaded.getState().activate(editor);
    expect(reloaded.getState()).toMatchObject({ status: 'synced', choice: null, pending: [] });
  });

  it('shows both copies when another device synced first and lets the user choose', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().update({ timeZone: 'UTC' });
    server.set({ ...defaultSyncedSettings, timeZone: 'Asia/Tokyo' });
    await store.getState().sync();
    expect(store.getState().status).toBe('choice');
    expect(store.getState().choice).toMatchObject({
      recovered: false,
      local: { timeZone: 'UTC' },
      remote: { settings: { timeZone: 'Asia/Tokyo' } },
    });
    expect(server.remote.settings?.timeZone).toBe('Asia/Tokyo');
    await store.getState().keepLocal();
    expect(server.remote.settings?.timeZone).toBe('UTC');
    expect(store.getState()).toMatchObject({ status: 'synced', choice: null });
  });

  it('syncs on tab hide only for edits made during this visit, with keepalive', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().syncOnHide();
    expect(server.calls.put).toHaveLength(0);
    store.getState().update({ englishSource: 'current' });
    store.getState().syncOnHide();
    await Promise.resolve();
    expect(server.calls.put).toEqual([
      expect.objectContaining({
        keepalive: true,
        settings: expect.objectContaining({ englishSource: 'current' }),
      }),
    ]);
  });

  it('uploads a signed-in copy only on exit when the account has none yet', async () => {
    const { storage } = memoryStorage({
      [settingsKey('anonymous')]: JSON.stringify({ settings: { dateFormat: 'iso' } }),
    });
    const server = fakeServer();
    const store = make(storage, server);
    await store.getState().activate(editor);
    expect(server.calls.put).toHaveLength(0);
    await store.getState().sync();
    expect(server.remote.settings?.dateFormat).toBe('iso');
  });

  it('never calls the API for signed-out users or when sync is not configured', async () => {
    const server = fakeServer();
    const store = createSettingsStore({
      storage: memoryStorage().storage,
      api: server.api,
      syncEnabled: false,
    });
    await store.getState().activate(editor);
    store.getState().update({ dateFormat: 'iso' });
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'device', reason: 'no-api', pending: [] });
    const signedOut = make(memoryStorage().storage, server);
    await signedOut.getState().activate(null);
    signedOut.getState().update({ dateFormat: 'iso' });
    await signedOut.getState().sync();
    expect(server.calls).toEqual({ get: 0, put: [] });
  });
});

describe('settings store: Settings exit, tab hide and late responses', () => {
  const ticks = async () => {
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  };

  it('never syncs on tab hide while Settings is open, but does for leftovers after leaving', async () => {
    const { values, storage } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    await store.getState().activate(editor);
    store.getState().enterSettings();
    store.getState().update({ dateFormat: 'iso' });
    store.getState().syncOnHide();
    await ticks();
    expect(server.calls.put).toHaveLength(0);
    // A close now relies on the persisted marker and the next-load prompt.
    expect(JSON.parse(values.get(settingsKey('7'))!).pending).toEqual(['dateFormat']);
    server.fail('offline');
    await store.getState().leaveSettings();
    expect(store.getState()).toMatchObject({ status: 'error', pending: ['dateFormat'] });
    server.fail('');
    store.getState().syncOnHide();
    await ticks();
    expect(server.calls.put.at(-1)).toMatchObject({ keepalive: true });
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [] });
  });

  it('queues an exit made while a sync is in flight and sends the latest state after it settles', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().enterSettings();
    store.getState().update({ dateFormat: 'iso' });
    server.hold();
    const first = store.getState().leaveSettings();
    store.getState().enterSettings();
    store.getState().update({ timeDisplay: 'date' });
    await store.getState().leaveSettings();
    expect(server.calls.put).toHaveLength(1);
    await server.release();
    await first;
    expect(server.calls.put).toHaveLength(2);
    // Based on the first PUT's answer, so no false conflict.
    expect(server.calls.put[1].revision).toBe('1'.padStart(40, 'a'));
    expect(server.remote.settings).toMatchObject({ dateFormat: 'iso', timeDisplay: 'date' });
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [], choice: null });
  });

  it('does not send edits made while back on Settings when the earlier sync settles', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().enterSettings();
    store.getState().update({ dateFormat: 'iso' });
    server.hold();
    const first = store.getState().leaveSettings();
    store.getState().enterSettings();
    store.getState().update({ timeDisplay: 'date' });
    await server.release();
    await first;
    expect(server.calls.put).toHaveLength(1);
    expect(store.getState()).toMatchObject({ status: 'unsynced', pending: ['timeDisplay'] });
    await store.getState().leaveSettings();
    expect(server.calls.put).toHaveLength(2);
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [] });
  });

  it('ends in the not-synced error state, changes kept, when the queued sync fails too', async () => {
    const server = fakeServer();
    const store = make(memoryStorage().storage, server);
    await store.getState().activate(editor);
    store.getState().enterSettings();
    store.getState().update({ dateFormat: 'iso' });
    server.hold();
    const first = store.getState().leaveSettings();
    store.getState().enterSettings();
    store.getState().update({ timeDisplay: 'date' });
    await store.getState().leaveSettings();
    server.fail('server answered HTTP 503');
    await server.release();
    await first;
    expect(server.calls.put).toHaveLength(2);
    expect(store.getState()).toMatchObject({
      status: 'error',
      error: 'server answered HTTP 503',
      pending: ['dateFormat', 'timeDisplay'],
    });
  });

  it('ignores a late response from before a reactivation', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer();
    const store = make(storage, server);
    await store.getState().activate(editor);
    store.getState().enterSettings();
    store.getState().update({ dateFormat: 'iso' });
    server.hold();
    const first = store.getState().leaveSettings();
    // Same user reactivated (e.g. login re-checked) while the PUT is still out: the pending
    // marker is recovered and needs a choice.
    await store.getState().activate(editor);
    expect(store.getState()).toMatchObject({ status: 'choice', revision: null });
    expect(store.getState().choice?.recovered).toBe(true);
    // The old PUT now succeeds on the server, but its answer must not clear the choice.
    await server.release();
    await first;
    expect(store.getState()).toMatchObject({
      status: 'choice',
      revision: null,
      pending: ['dateFormat'],
    });
    expect(store.getState().choice?.recovered).toBe(true);
    store.getState().update({ timeZone: 'UTC' });
    store.getState().syncOnHide();
    await ticks();
    expect(server.calls.put).toHaveLength(1);
  });
});

describe('editor font device preference', () => {
  it('defaults older/invalid device copies and persists a choice across users and reload', async () => {
    const { storage } = memoryStorage({ [deviceKey]: JSON.stringify({ textSize: 'large' }) });
    const server = fakeServer();
    const store = make(storage, server);
    expect(store.getState().device.editorFont).toBe('default');
    await store.getState().activate(editor);
    store.getState().updateDevice({ editorFont: 'fira-code' });
    await store.getState().leaveSettings();
    expect(server.calls.put).toHaveLength(0);
    expect(store.getState().pending).toEqual([]);
    await store.getState().activate({ id: 99, role: 'translator' });
    expect(store.getState().device.editorFont).toBe('fira-code');
    expect(make(storage, server).getState().device.editorFont).toBe('fira-code');
    storage.set(deviceKey, JSON.stringify({ editorFont: 'unknown' }));
    expect(make(storage, server).getState().device.editorFont).toBe('default');
  });
});

describe('settings store: two tabs', () => {
  it('preserves another tab pending edit and recovery marker when a delayed GET finishes', async () => {
    const { storage, values } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    await a.getState().activate(editor);
    let release!: (remote: typeof server.remote) => void;
    const b = createSettingsStore({
      storage,
      syncEnabled: true,
      api: {
        ...server.api,
        get: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    const loading = b.getState().activate(editor);
    a.getState().enterSettings();
    a.getState().update({ dateFormat: 'iso' });
    const marker = a.getState().pendingSince;
    release({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    await loading;
    expect(JSON.parse(values.get(settingsKey('7'))!)).toMatchObject({
      settings: { dateFormat: 'iso' },
      pending: ['dateFormat'],
      pendingSince: marker,
    });
    // A live tab's edit is imported as pending, not as an "earlier visit" prompt.
    expect(b.getState()).toMatchObject({
      status: 'unsynced',
      choice: null,
      pending: ['dateFormat'],
      settings: { dateFormat: 'iso' },
    });
    b.getState().syncOnHide();
    expect(server.calls.put).toHaveLength(0);
    const reloaded = make(storage, server);
    await reloaded.getState().activate(editor);
    expect(reloaded.getState()).toMatchObject({
      status: 'choice',
      choice: { recovered: true, local: { dateFormat: 'iso' } },
    });
  });

  it('reconciles disjoint and same-field edits before writing even without storage events', async () => {
    const { storage, values } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    const b = make(storage, server);
    await a.getState().activate(editor);
    await b.getState().activate(editor);
    a.getState().update({ dateFormat: 'iso' });
    b.getState().update({ timeZone: 'UTC' });
    a.getState().update({ dateFormat: 'mdy' });
    const copy = JSON.parse(values.get(settingsKey('7'))!);
    expect(copy.settings).toMatchObject({ dateFormat: 'mdy', timeZone: 'UTC' });
    expect(copy.pending.sort()).toEqual(['dateFormat', 'timeZone']);
    b.getState().update({ dateFormat: 'dmy' });
    expect(JSON.parse(values.get(settingsKey('7'))!).settings).toMatchObject({
      dateFormat: 'dmy',
      timeZone: 'UTC',
    });
  });

  it('reacts to storage events without writing or uploading the other tab edits', async () => {
    const { storage, values } = memoryStorage();
    const listeners: ((key: string | null) => void)[] = [];
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    const b = make(
      {
        ...storage,
        subscribe: (listener) => {
          listeners.push(listener);
        },
      },
      server,
    );
    await a.getState().activate(editor);
    await b.getState().activate(editor);
    a.getState().update({ dateFormat: 'iso' });
    const raw = values.get(settingsKey('7'));
    listeners.forEach((listener) => listener(settingsKey('8')));
    expect(b.getState().settings.dateFormat).toBe('auto');
    listeners.forEach((listener) => listener(settingsKey('7')));
    expect(b.getState()).toMatchObject({
      settings: { dateFormat: 'iso' },
      pending: ['dateFormat'],
      status: 'unsynced',
      choice: null,
    });
    expect(values.get(settingsKey('7'))).toBe(raw);
    expect(server.calls.put).toHaveLength(0);
  });

  it('does not clear a pending marker when a tab temporarily has no sync access', async () => {
    const { storage, values } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    await a.getState().activate(editor);
    a.getState().update({ dateFormat: 'iso' });
    const b = make(storage, server);
    await b.getState().activate({ ...editor, role: null });
    b.getState().update({ timeZone: 'UTC' });
    expect(JSON.parse(values.get(settingsKey('7'))!)).toMatchObject({
      settings: { dateFormat: 'iso', timeZone: 'UTC' },
      pending: ['dateFormat'],
      pendingSince: a.getState().pendingSince,
    });
  });

  it('clears a stale recovery choice after the other tab acknowledges pending settings', async () => {
    const { storage } = memoryStorage();
    const listeners: ((key: string | null) => void)[] = [];
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    const b = make(
      {
        ...storage,
        subscribe: (listener) => {
          listeners.push(listener);
        },
      },
      server,
    );
    await a.getState().activate(editor);
    await b.getState().activate(editor);
    a.getState().update({ dateFormat: 'iso' });
    listeners.forEach((listener) => listener(settingsKey('7')));
    expect(b.getState().status).toBe('unsynced');
    await a.getState().sync();
    listeners.forEach((listener) => listener(settingsKey('7')));
    expect(b.getState()).toMatchObject({ status: 'synced', choice: null, pending: [] });
    b.getState().update({ timeZone: 'UTC' });
    await b.getState().sync();
    expect(server.calls.put).toHaveLength(2);
  });

  it('keeps edits made in another tab while a PUT is in flight', async () => {
    const { storage, values } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: null });
    const a = make(storage, server);
    const b = make(storage, server);
    await a.getState().activate(editor);
    await b.getState().activate(editor);
    a.getState().update({ dateFormat: 'iso' });
    server.hold();
    const sending = a.getState().sync();
    b.getState().update({ dateFormat: 'mdy', timeZone: 'UTC' });
    await server.release();
    await sending;
    expect(JSON.parse(values.get(settingsKey('7'))!)).toMatchObject({
      settings: { dateFormat: 'mdy', timeZone: 'UTC' },
      pending: ['dateFormat', 'timeZone'],
    });
    expect(a.getState()).toMatchObject({ status: 'unsynced', choice: null });
    expect(server.calls.put).toHaveLength(1);
    const reloaded = make(storage, server);
    await reloaded.getState().activate(editor);
    expect(reloaded.getState().choice?.recovered).toBe(true);
  });

  it('drops a GET that finished after another tab synced newer settings and asks again', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    await a.getState().activate(editor);
    const stale = { settings: { ...defaultSyncedSettings }, revision: 'r1' };
    let release!: (remote: typeof stale) => void;
    let gets = 0;
    const b = createSettingsStore({
      storage,
      syncEnabled: true,
      api: {
        ...server.api,
        get: () =>
          gets++ === 0
            ? new Promise((resolve) => {
                release = resolve;
              })
            : server.api.get(),
      },
    });
    const loading = b.getState().activate(editor);
    a.getState().update({ dateFormat: 'iso' });
    await a.getState().sync();
    release(stale);
    await loading;
    expect(gets).toBe(2);
    expect(b.getState().settings.dateFormat).toBe('iso');
    expect(b.getState().revision).toBe(server.remote.revision);
    // The first tab keeps its saved value and is not pushed into a conflict.
    a.getState().update({ timeZone: 'UTC' });
    await a.getState().sync();
    expect(a.getState()).toMatchObject({
      status: 'synced',
      choice: null,
      settings: { dateFormat: 'iso', timeZone: 'UTC' },
    });
    expect(server.remote.settings).toMatchObject({ dateFormat: 'iso', timeZone: 'UTC' });
  });

  it('never offers an out-of-date account copy because another open tab has pending edits', async () => {
    const { storage } = memoryStorage();
    const server = fakeServer({ settings: { ...defaultSyncedSettings }, revision: 'r1' });
    const a = make(storage, server);
    const b = make(storage, server);
    await a.getState().activate(editor);
    await b.getState().activate(editor);
    b.getState().update({ timeZone: 'UTC' });
    server.hold();
    const sending = b.getState().sync();
    a.getState().update({ dateFormat: 'iso' });
    await server.release();
    await sending;
    expect(a.getState().choice).toBeNull();
    expect(b.getState().choice).toBeNull();
    expect(a.getState()).toMatchObject({
      status: 'unsynced',
      settings: { dateFormat: 'iso', timeZone: 'UTC' },
    });
    await a.getState().sync();
    expect(a.getState().status).toBe('synced');
    expect(server.remote.settings).toMatchObject({ dateFormat: 'iso', timeZone: 'UTC' });
  });
});
