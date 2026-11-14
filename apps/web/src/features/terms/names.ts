import { z } from 'zod';
import { create } from 'zustand';
import type { Lang } from '@clarity/core';
import { generatorSource } from '../../services/generator';
import { errorMessage, fetchOptionalJson } from '../../services/http';

/**
 * Official game names in one language (TR2): the generator's names file for that language
 * (templates/v2/names/<lang>.json, names only, ~100 KB instead of the raw item table). Keys are
 * hashes from the generator's items.json: `names` by each item's own hash (its definition table),
 * `itemNames` by the owning exotic's item hash (`itemHash`, `owners`), `setNames` by armor set.
 */
const hashKey = z.string().regex(/^\d+$/);
export const namesFileSchema = z.object({
  v: z.literal(1),
  lang: z.string(),
  manifestVersion: z.string(),
  names: z.record(hashKey, z.string()),
  itemNames: z.record(hashKey, z.string()),
  setNames: z.record(hashKey, z.string()),
});
export type NamesFile = z.infer<typeof namesFileSchema>;

export const namesUrl = (lang: Lang) => `${generatorSource}/names/${lang}.json`;

export type NamesState =
  | { status: 'loading' }
  | { status: 'ready'; file: NamesFile; stale?: boolean }
  /** No names file for this language (not generated yet). */
  | { status: 'missing' }
  | { status: 'error'; error: string };

interface NamesStore {
  byLang: Partial<Record<Lang, NamesState>>;
}
export const useNamesStore = create<NamesStore>(() => ({ byLang: {} }));
const setState = (lang: Lang, state: NamesState) =>
  useNamesStore.setState((store) => ({ byLang: { ...store.byLang, [lang]: state } }));

// --- Per-device cache (optional: blocked storage only means a fetch on every start) ---
const databaseName = 'clarity-terms-v1';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('names');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readCache(lang: Lang): Promise<NamesFile | undefined> {
  let db: IDBDatabase | undefined;
  try {
    if (typeof indexedDB === 'undefined') return undefined;
    db = await database();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db!.transaction('names').objectStore('names').get(lang);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const parsed = namesFileSchema.safeParse(value);
    return parsed.success && parsed.data.lang === lang ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
async function writeCache(lang: Lang, file: NamesFile | undefined): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    if (typeof indexedDB === 'undefined') return;
    db = await database();
    await new Promise<void>((resolve, reject) => {
      const store = db!.transaction('names', 'readwrite').objectStore('names');
      const request = file ? store.put(file, lang) : store.delete(lang);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    /* Private browsing or a storage policy: the next start fetches again. */
  } finally {
    db?.close();
  }
}

/** Languages already requested this session: one network check per language per session. */
const requested = new Set<Lang>();

/**
 * Loads one language's names, once per session: the device's cached copy first (shown at once),
 * then the network copy, which replaces it when it differs. Offline with a cached copy keeps the
 * copy (marked stale); offline without one is an error; a missing file is `missing`.
 */
export function ensureNames(lang: Lang): void {
  if (lang === 'en' || requested.has(lang)) return;
  requested.add(lang);
  setState(lang, { status: 'loading' });
  void (async () => {
    const cached = await readCache(lang);
    if (cached) setState(lang, { status: 'ready', file: cached });
    try {
      const file = await fetchOptionalJson(namesUrl(lang), namesFileSchema);
      if (file && file.lang !== lang) throw new Error(`Names file for ${file.lang}, not ${lang}`);
      if (!file) {
        setState(lang, { status: 'missing' });
        if (cached) void writeCache(lang, undefined);
        return;
      }
      if (!cached || JSON.stringify(cached) !== JSON.stringify(file)) {
        setState(lang, { status: 'ready', file });
        void writeCache(lang, file);
      }
    } catch (error) {
      if (cached) setState(lang, { status: 'ready', file: cached, stale: true });
      else {
        // A later visit to this language may retry (the connection may be back).
        requested.delete(lang);
        setState(lang, { status: 'error', error: errorMessage(error) });
      }
    }
  })();
}

/** Tests only: forget the session's requests and loaded names. */
export function resetNamesForTests(): void {
  requested.clear();
  useNamesStore.setState({ byLang: {} });
}
