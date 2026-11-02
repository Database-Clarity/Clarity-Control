import { create } from 'zustand';
import {
  defaultSyncedSettings,
  stableStringify,
  syncedSettingsSchema,
  type SyncedSettings,
} from '@clarity/core';
import { z } from 'zod';
import {
  apiUrl,
  getSettings,
  putSettings,
  type RemoteSettings,
  type SettingsPutResult,
} from '../services/api';
import { errorMessage } from '../services/http';

/*
 * Settings come in two kinds:
 * - synced (dates, editor defaults): per user scope, saved in this browser at once and sent to
 *   the Worker only when the user leaves the Settings page (or best-effort on tab hide). A
 *   persisted `pending` list survives crashes; the next load asks before overwriting anything.
 * - device (text size, layout): this browser only, never synced, never prompted.
 */
export type SyncedKey = keyof SyncedSettings;
export const syncedKeys = Object.keys(defaultSyncedSettings) as SyncedKey[];
export const deviceSettingsSchema = z.object({ textSize: z.enum(['default', 'large']) });
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export const defaultDeviceSettings: DeviceSettings = { textSize: 'default' };

export const settingsKey = (scope: string) => `clarity-settings:v1:${scope}`;
export const deviceKey = 'clarity-settings:device:v1';
export const legacyToolbarKey = 'clarity-translator-markup-toolbar';
export const legacySourceKey = 'clarity-english-source-view';
export const layoutKey = 'description-editor-split';

/**
 * - device: this user cannot sync (signed out, no role, no API); saved in this browser only
 * - loading: fetching the synced copy
 * - synced / unsynced: local copy matches the account, or has changes waiting for Settings exit
 * - syncing / error: a sync is running, or failed (changes kept here; retry offered)
 * - choice: this browser and the account differ; the user must pick one
 */
export type SyncStatus =
  'device' | 'loading' | 'synced' | 'unsynced' | 'syncing' | 'error' | 'choice';
export type DeviceReason = 'signed-out' | 'no-role' | 'no-api';
export interface SettingsChoice {
  local: SyncedSettings;
  remote: RemoteSettings;
  /** True when the local changes were recovered from an earlier visit (tab closed or crashed). */
  recovered: boolean;
  since: string | null;
}

export interface SettingsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
export interface SettingsApi {
  get(): Promise<RemoteSettings>;
  put(
    settings: SyncedSettings,
    revision: string | null,
    keepalive?: boolean,
  ): Promise<SettingsPutResult>;
}

export interface SettingsState {
  scope: string;
  settings: SyncedSettings;
  device: DeviceSettings;
  revision: string | null;
  pending: SyncedKey[];
  pendingSince: string | null;
  status: SyncStatus;
  reason: DeviceReason;
  error: string;
  /** Problems reading or writing this browser's copy. */
  notice: string;
  choice: SettingsChoice | null;
  activate(user: { id: number | string; role: string | null } | null): Promise<void>;
  update(patch: Partial<SyncedSettings>): void;
  updateDevice(patch: Partial<DeviceSettings>): void;
  /** Called when leaving the Settings page; no-op unless changes are waiting. */
  sync(options?: { keepalive?: boolean }): Promise<void>;
  /** Best-effort sync when the tab is hidden or closed, only for this visit's own edits. */
  syncOnHide(): void;
  keepLocal(): Promise<void>;
  useRemote(): void;
  retry(): Promise<void>;
  resetLayout(): void;
}

function browserStorage(): SettingsStorage {
  if (typeof window === 'undefined') {
    // Server rendering and node tests: keep settings in memory.
    const values = new Map<string, string>();
    return {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => void values.set(key, value),
      remove: (key) => void values.delete(key),
    };
  }
  return {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
  };
}

export function applyDeviceSettings(device: DeviceSettings): void {
  if (typeof document === 'undefined') return;
  if (device.textSize === 'large') document.documentElement.dataset.textSize = 'large';
  else delete document.documentElement.dataset.textSize;
}

const same = (a: SyncedSettings | null, b: SyncedSettings | null) =>
  stableStringify(a) === stableStringify(b);

/** Field-wise validation: unknown keys drop, bad values fall back to defaults, never throws. */
function readSynced(raw: unknown): SyncedSettings {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const settings = { ...defaultSyncedSettings };
  for (const key of syncedKeys) {
    const result = syncedSettingsSchema.shape[key].safeParse(record[key]);
    if (result.success) Object.assign(settings, { [key]: result.data });
  }
  return settings;
}

const storedSchema = z.object({
  settings: z.unknown(),
  revision: z.string().nullable().catch(null),
  pending: z.array(z.string()).catch([]),
  pendingSince: z.string().nullable().catch(null),
});

interface ScopeCopy {
  settings: SyncedSettings;
  revision: string | null;
  pending: SyncedKey[];
  pendingSince: string | null;
}

export function createSettingsStore({
  storage = browserStorage(),
  api = {
    get: () => getSettings(),
    put: (settings, revision, keepalive) => putSettings(settings, revision, keepalive),
  },
  syncEnabled = Boolean(apiUrl),
  now = () => new Date().toISOString(),
}: {
  storage?: SettingsStorage;
  api?: SettingsApi;
  syncEnabled?: boolean;
  now?: () => string;
} = {}) {
  let notice = '';
  const read = (key: string) => {
    try {
      return storage.get(key);
    } catch (error) {
      notice = `Settings cannot be read in this browser (${errorMessage(error)}); defaults are in use.`;
      return null;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      storage.set(key, JSON.stringify(value));
      return '';
    } catch (error) {
      return `Settings cannot be saved in this browser (${errorMessage(error)}); they last until you reload.`;
    }
  };

  function parse(raw: string | null): ScopeCopy | null {
    if (raw === null) return null;
    try {
      const stored = storedSchema.parse(JSON.parse(raw));
      const pending = syncedKeys.filter((key) => stored.pending.includes(key));
      return {
        settings: readSynced(stored.settings),
        revision: stored.revision,
        pending,
        pendingSince: pending.length ? stored.pendingSince : null,
      };
    } catch {
      notice = 'Saved settings could not be read; defaults are in use.';
      return {
        settings: { ...defaultSyncedSettings },
        revision: null,
        pending: [],
        pendingSince: null,
      };
    }
  }

  function migrateLegacy(): ScopeCopy | null {
    const toolbar = read(legacyToolbarKey);
    const source = read(legacySourceKey);
    if (toolbar === null && source === null) return null;
    const settings = { ...defaultSyncedSettings };
    if (toolbar === 'open' || toolbar === 'closed') settings.markupToolbar = toolbar;
    if (source === 'current' || source === 'changes') settings.englishSource = source;
    return { settings, revision: null, pending: [], pendingSince: null };
  }

  /** Reads one scope; a new user scope adopts the signed-out copy once. */
  function load(scope: string): ScopeCopy {
    notice = '';
    let copy = parse(read(settingsKey(scope)));
    if (!copy) {
      const adopted =
        scope === 'anonymous' ? migrateLegacy() : parse(read(settingsKey('anonymous')));
      copy = adopted
        ? { settings: adopted.settings, revision: null, pending: [], pendingSince: null }
        : {
            settings: { ...defaultSyncedSettings },
            revision: null,
            pending: [],
            pendingSince: null,
          };
      if (adopted) {
        const failed = write(settingsKey(scope), copy);
        if (scope === 'anonymous' && !failed) {
          try {
            storage.remove(legacyToolbarKey);
            storage.remove(legacySourceKey);
          } catch {
            /* The old keys are re-read harmlessly next time. */
          }
        }
        notice ||= failed;
      }
    }
    return copy;
  }

  function loadDevice(): DeviceSettings {
    try {
      const raw = read(deviceKey);
      const record: unknown = raw === null ? {} : JSON.parse(raw);
      const result = deviceSettingsSchema.shape.textSize.safeParse(
        (record as Record<string, unknown> | null)?.textSize,
      );
      return { textSize: result.success ? result.data : 'default' };
    } catch {
      return { ...defaultDeviceSettings };
    }
  }

  let activation = 0;
  let inFlight = false;
  let canSync = false;
  let remoteLoaded = false;
  /** Server has no readable copy yet, so the next Settings exit uploads this browser's. */
  let uploadNeeded = false;
  /** Pending changes from an earlier visit; never sent without asking. */
  let recovered = false;
  /** Changes made during this visit, eligible for the best-effort sync on tab hide. */
  let sessionEdits = false;
  /** The user left Settings while the account copy was still loading: sync once it lands. */
  let exitRequested = false;

  const initial = load('anonymous');
  const initialNotice = notice;
  const device = loadDevice();
  applyDeviceSettings(device);

  return create<SettingsState>((set, get) => {
    function persist(): void {
      const { scope, settings, revision, pending, pendingSince } = get();
      const failed = write(settingsKey(scope), { settings, revision, pending, pendingSince });
      if (
        failed !== get().notice &&
        (failed || get().notice.startsWith('Settings cannot be saved'))
      )
        set({ notice: failed });
    }

    function synced(remote: RemoteSettings, sent: SyncedSettings): void {
      const current = get().settings;
      const pending = get().pending.filter((key) => current[key] !== sent[key]);
      uploadNeeded = false;
      recovered = false;
      set({
        revision: remote.revision,
        pending,
        pendingSince: pending.length ? get().pendingSince : null,
        status: pending.length ? 'unsynced' : 'synced',
        choice: null,
        error: '',
      });
      persist();
    }

    async function send(settings: SyncedSettings, revision: string | null, keepalive = false) {
      const scope = get().scope;
      inFlight = true;
      set({ status: 'syncing', error: '' });
      const result = await api.put(settings, revision, keepalive);
      inFlight = false;
      if (get().scope !== scope) return;
      if (result.kind === 'synced') return synced(result.remote, settings);
      if (result.kind === 'conflict') {
        if (same(result.remote.settings, get().settings)) return synced(result.remote, settings);
        set({
          status: 'choice',
          choice: {
            local: get().settings,
            remote: result.remote,
            recovered: false,
            since: get().pendingSince,
          },
        });
        return;
      }
      set({ status: 'error', error: result.error });
    }

    async function refresh(token: number): Promise<void> {
      set({ status: 'loading', error: '' });
      let remote: RemoteSettings;
      try {
        remote = await api.get();
      } catch (error) {
        if (token === activation) set({ status: 'error', error: errorMessage(error) });
        return;
      }
      if (token !== activation) return;
      remoteLoaded = true;
      const state = get();
      uploadNeeded = remote.settings === null;
      if (state.pending.length) {
        if (same(remote.settings, state.settings)) return synced(remote, state.settings);
        if (recovered) {
          set({
            status: 'choice',
            choice: { local: state.settings, remote, recovered: true, since: state.pendingSince },
          });
          return;
        }
        // Edits made while loading win over the account copy, field by field.
        const base = remote.settings ?? state.settings;
        const settings = { ...base };
        for (const key of state.pending) Object.assign(settings, { [key]: state.settings[key] });
        set({ settings, revision: remote.revision, status: 'unsynced' });
        persist();
        if (exitRequested) {
          exitRequested = false;
          await get().sync();
        }
        return;
      }
      if (remote.settings) {
        set({ settings: remote.settings, revision: remote.revision, status: 'synced' });
      } else {
        set({
          revision: remote.revision,
          status: same(state.settings, defaultSyncedSettings) ? 'synced' : 'unsynced',
        });
      }
      persist();
    }

    return {
      scope: 'anonymous',
      ...initial,
      device,
      status: 'device',
      reason: syncEnabled ? 'signed-out' : 'no-api',
      error: '',
      notice: initialNotice,
      choice: null,

      async activate(user) {
        const token = ++activation;
        const scope = user ? String(user.id) : 'anonymous';
        const copy = load(scope);
        canSync = Boolean(syncEnabled && user?.role);
        remoteLoaded = false;
        uploadNeeded = false;
        sessionEdits = false;
        exitRequested = false;
        recovered = canSync && copy.pending.length > 0;
        set({
          scope,
          ...copy,
          ...(canSync ? {} : { pending: [], pendingSince: null }),
          notice,
          choice: null,
          error: '',
          status: canSync ? 'loading' : 'device',
          reason: !syncEnabled ? 'no-api' : user ? 'no-role' : 'signed-out',
        });
        if (canSync) await refresh(token);
      },

      update(patch) {
        const state = get();
        const settings = readSynced({ ...state.settings, ...patch });
        const changed = syncedKeys.filter((key) => settings[key] !== state.settings[key]);
        if (!changed.length) return;
        if (!canSync) {
          set({ settings });
          persist();
          return;
        }
        sessionEdits = true;
        const pending = syncedKeys.filter(
          (key) => state.pending.includes(key) || changed.includes(key),
        );
        set({
          settings,
          pending,
          pendingSince: state.pendingSince ?? now(),
          ...(state.choice ? { choice: { ...state.choice, local: settings } } : {}),
          ...(['synced', 'error'].includes(state.status) ? { status: 'unsynced' as const } : {}),
        });
        persist();
      },

      updateDevice(patch) {
        const device = { ...get().device, ...patch };
        set({ device, notice: write(deviceKey, device) });
        applyDeviceSettings(device);
      },

      async sync({ keepalive = false } = {}) {
        const state = get();
        if (canSync && state.status === 'loading' && !keepalive) exitRequested = true;
        if (!canSync || inFlight || state.choice || state.status === 'loading') return;
        if (!state.pending.length && !(uploadNeeded && remoteLoaded)) return;
        if (uploadNeeded && !state.pending.length && same(state.settings, defaultSyncedSettings))
          return;
        await send(state.settings, state.revision, keepalive);
      },

      syncOnHide() {
        if (sessionEdits && !recovered) void get().sync({ keepalive: true });
      },

      async keepLocal() {
        const choice = get().choice;
        if (!choice || inFlight) return;
        recovered = false;
        set({ choice: null });
        await send(get().settings, choice.remote.revision);
      },

      useRemote() {
        const choice = get().choice;
        if (!choice) return;
        recovered = false;
        uploadNeeded = false;
        set({
          settings: choice.remote.settings ?? { ...defaultSyncedSettings },
          revision: choice.remote.revision,
          pending: [],
          pendingSince: null,
          choice: null,
          status: 'synced',
          error: '',
        });
        persist();
      },

      async retry() {
        if (!canSync) return;
        if (!remoteLoaded) return refresh(activation);
        return get().sync();
      },

      resetLayout() {
        try {
          storage.remove(layoutKey);
          set({ notice: '' });
        } catch (error) {
          set({ notice: `Cannot reset the layout: ${errorMessage(error)}` });
        }
      },
    };
  });
}

export const useSettingsStore = createSettingsStore();
export const useSyncedSettings = () => useSettingsStore((state) => state.settings);
