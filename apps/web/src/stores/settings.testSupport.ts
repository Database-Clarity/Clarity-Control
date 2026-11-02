import type { SyncedSettings } from '@clarity/core';
import type { RemoteSettings } from '../services/api';
import type { SettingsApi, SettingsStorage } from './settings';

export function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: SettingsStorage = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
  return { values, storage };
}

export function fakeServer(initial: RemoteSettings = { settings: null, revision: null }) {
  let remote = structuredClone(initial);
  let sequence = 0;
  const calls = {
    get: 0,
    put: [] as { settings: SyncedSettings; revision: string | null; keepalive?: boolean }[],
  };
  let failing = '';
  const api: SettingsApi = {
    async get() {
      calls.get++;
      if (failing) throw new Error(failing);
      return structuredClone(remote);
    },
    async put(settings, revision, keepalive) {
      calls.put.push({ settings, revision, keepalive });
      if (failing) return { kind: 'failed', error: failing };
      if (revision !== remote.revision)
        return { kind: 'conflict', remote: structuredClone(remote) };
      remote = { settings, revision: String(++sequence).padStart(40, 'a') };
      return { kind: 'synced', remote: structuredClone(remote) };
    },
  };
  return {
    api,
    calls,
    get remote() {
      return remote;
    },
    /** Another device syncs. */
    set(settings: SyncedSettings) {
      remote = { settings, revision: String(++sequence).padStart(40, 'b') };
    },
    fail(message: string) {
      failing = message;
    },
  };
}
