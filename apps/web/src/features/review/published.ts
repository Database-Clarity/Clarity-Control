import { tooltipSchema, type Tooltip } from '@clarity/core';
import { create } from 'zustand';
import { getPushedVersion } from '../../services/history';
import { errorMessage } from '../../services/http';
import { sameUser, useAuthStore } from '../../stores/auth';

/**
 * The published text of every waiting change, loaded once in the background (spec "Review changes
 * redesign" §11). A pushed marker never changes what it points at, so a result is kept per hash and
 * marker: in memory, and on this device in IndexedDB (one record per hash, the newest marker), so a
 * later visit needs no request at all. Never-published rows have no marker and send no request.
 */
export type Published =
  /** `tooltip` null: the server has no published version (a new tooltip). */
  | { status: 'ready'; tooltip: Tooltip | null }
  | { status: 'loading' }
  /** The request failed; Retry asks again. */
  | { status: 'error'; error: string }
  /** A legacy marker whose text could not be recovered from history (the Worker's 409). */
  | { status: 'missing' };

type Entry = Published & { marker: string };

interface PublishedState {
  byHash: Readonly<Record<number, Entry>>;
}
export const usePublished = create<PublishedState>(() => ({ byHash: {} }));

/** The published state for this marker, or undefined when nothing was asked yet. */
export function publishedFor(
  byHash: PublishedState['byHash'],
  hash: number,
  marker: string | undefined,
): Published | undefined {
  if (marker === undefined) return { status: 'ready', tooltip: null };
  const entry = byHash[hash];
  return entry?.marker === marker ? entry : undefined;
}

function put(hash: number, entry: Entry) {
  usePublished.setState((state) => ({ byHash: { ...state.byHash, [hash]: entry } }));
}

// ---- device cache (optional: blocked storage only means a request per visit) ----
interface Stored {
  marker: string;
  tooltip: unknown;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clarity-review-published-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tooltips');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readStored(hashes: number[]): Promise<Map<number, Stored>> {
  const found = new Map<number, Stored>();
  if (!hashes.length || typeof indexedDB === 'undefined') return found;
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    const store = db.transaction('tooltips').objectStore('tooltips');
    await Promise.all(
      hashes.map(
        (hash) =>
          new Promise<void>((resolve) => {
            const request = store.get(hash);
            request.onsuccess = () => {
              if (request.result) found.set(hash, request.result as Stored);
              resolve();
            };
            request.onerror = () => resolve();
          }),
      ),
    );
  } catch {
    // Private browsing or a storage policy: ask the server instead.
  } finally {
    db?.close();
  }
  return found;
}
async function writeStored(hash: number, value: Stored) {
  if (typeof indexedDB === 'undefined') return;
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    db.transaction('tooltips', 'readwrite').objectStore('tooltips').put(value, hash);
  } catch {
    // Not stored: the next visit asks again.
  } finally {
    db?.close();
  }
}

// ---- loading ----
/** Requests at once: enough to finish a typical batch quickly, few enough to stay polite. */
const parallel = 4;
const queued: { hash: number; marker: string }[] = [];
let running = 0;
/** A reset (account change) frees the slots of requests still out; they finish unheard. */
let generation = 0;

function pump() {
  while (running < parallel && queued.length) {
    const { hash, marker } = queued.shift()!;
    if (usePublished.getState().byHash[hash]?.marker !== marker) continue;
    running++;
    const started = generation;
    void getPushedVersion(hash)
      .then(
        (result) => {
          if (started !== generation || usePublished.getState().byHash[hash]?.marker !== marker)
            return;
          put(hash, { status: 'ready', tooltip: result.tooltip, marker });
          // Only the exact pair is immutable; a server marker newer than ours shows once, unstored.
          if (result.pushedHash === marker && result.tooltip)
            void writeStored(hash, { marker, tooltip: result.tooltip });
        },
        (reason: unknown) => {
          if (started !== generation || usePublished.getState().byHash[hash]?.marker !== marker)
            return;
          const error = errorMessage(reason);
          put(
            hash,
            /^API HTTP 409\b/.test(error)
              ? { status: 'missing', marker }
              : { status: 'error', error, marker },
          );
        },
      )
      .finally(() => {
        if (started !== generation) return;
        running--;
        pump();
      });
  }
}

/**
 * Make the published text of these rows available: memory first, then this device, then the
 * server (a few at a time). `retry` asks again for rows whose last request failed.
 */
export async function loadPublished(
  rows: readonly { hash: number; marker: string | undefined }[],
  retry = false,
): Promise<void> {
  const byHash = usePublished.getState().byHash;
  const wanted = rows.filter(
    (row): row is { hash: number; marker: string } =>
      row.marker !== undefined &&
      (byHash[row.hash]?.marker !== row.marker || (retry && byHash[row.hash]?.status === 'error')),
  );
  if (!wanted.length) return;
  usePublished.setState((state) => {
    const next = { ...state.byHash };
    for (const { hash, marker } of wanted) next[hash] = { status: 'loading', marker };
    return { byHash: next };
  });
  const started = generation;
  const stored = await readStored(wanted.map(({ hash }) => hash));
  // A reset (account change) while the device cache was read discards this load entirely.
  if (started !== generation) return;
  const hits: Record<number, Entry> = {};
  for (const row of wanted) {
    const value = stored.get(row.hash);
    const parsed = value?.marker === row.marker ? tooltipSchema.safeParse(value.tooltip) : null;
    if (parsed?.success && parsed.data.hash === row.hash)
      hits[row.hash] = { status: 'ready', tooltip: parsed.data, marker: row.marker };
    else queued.push(row);
  }
  if (Object.keys(hits).length)
    usePublished.setState((state) => {
      const next = { ...state.byHash };
      for (const [hash, entry] of Object.entries(hits))
        if (next[Number(hash)]?.marker === entry.marker) next[Number(hash)] = entry;
      return { byHash: next };
    });
  pump();
}

/** The rows whose published text a snapshot needs: published changes (not leftovers, not new). */
export function publishedRows(
  entries: readonly { markerOnly: boolean; pushed?: string; tooltip: { hash: number } }[],
) {
  return entries
    .filter(({ markerOnly, pushed }) => !markerOnly && pushed !== undefined)
    .map(({ tooltip, pushed }) => ({ hash: tooltip.hash, marker: pushed }));
}

// A failed request (signed out, 401) must not stick to the next account; the device cache stays.
useAuthStore.subscribe((state, previous) => {
  if (state.user !== previous.user && !sameUser(state.user, previous.user)) resetPublished();
});

/** Forget everything loaded or asked for (a signed-in account changed; tests). */
export function resetPublished() {
  generation++;
  running = 0;
  queued.length = 0;
  usePublished.setState({ byHash: {} });
}
