import { tooltipSchema, usesEnglishFallback, type Lang, type Tooltip } from '@clarity/core';
import { create } from 'zustand';
import { getPushedVersion } from '../../services/history';
import { errorMessage } from '../../services/http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { matchesLane, type Lane } from './lanes';
import type { PendingTooltip } from './model';

/**
 * The published text of every waiting change, loaded once in the background (spec "Review changes
 * redesign" §11). A pushed marker never changes what it points at, so a result is kept per hash and
 * marker (and its exact snapshot where known): in memory, and on this device in IndexedDB (one record per hash, the newest marker), so a
 * later visit needs no request at all. Never-published rows have no marker and send no request.
 */
export type Published =
  /** `tooltip` null: the server has no published version (a new tooltip). */
  | { status: 'ready'; tooltip: Tooltip | null }
  | { status: 'loading' }
  /** The request failed; Retry asks again. */
  | { status: 'error'; error: string }
  /** A legacy marker whose text could not be recovered from history (the Worker's 409). */
  | { status: 'missing' }
  /** The server's version is not the one a translator's row was prepared from. */
  | { status: 'changed' };

type Entry = Published & { marker: string; facts?: readonly string[] };

interface Wanted {
  hash: number;
  marker: string;
  /** A translator's rows: is this exactly the version they were prepared from? */
  matches?: (tooltip: Tooltip) => Promise<boolean>;
  /** The signed facts `matches` checks, one per row; a request with another one checks again. */
  facts?: readonly string[];
}

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

/**
 * The text a language goes live with: a translation that falls back goes out in English (the
 * same rule as the publish digest), so a fallback flip is a change players see.
 */
export function exportedText(tooltip: Tooltip | null, lang: Lang): string {
  if (!tooltip) return '';
  return usesEnglishFallback(tooltip, lang)
    ? (tooltip.text.en?.text ?? '')
    : (tooltip.text[lang]?.text ?? '');
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
const queued: Wanted[] = [];
let running = 0;
/** A reset (account change) frees the slots of requests still out; they finish unheard. */
let generation = 0;

function pump() {
  while (running < parallel && queued.length) {
    const { hash, marker, matches, facts } = queued.shift()!;
    const wanted = () => {
      const entry = usePublished.getState().byHash[hash];
      return entry?.marker === marker && entry.facts === facts;
    };
    if (!wanted()) continue;
    running++;
    const started = generation;
    void getPushedVersion(hash)
      .then(async (result) => ({
        ...result,
        matched: !matches || (!!result.tooltip && (await matches(result.tooltip))),
      }))
      .then(
        (result) => {
          if (started !== generation || !wanted()) return;
          if (!result.matched) return put(hash, { status: 'changed', marker, facts });
          put(hash, { status: 'ready', tooltip: result.tooltip, marker, facts });
          // Only the exact pair is immutable; a server marker newer than ours shows once, unstored.
          if (result.pushedHash === marker.split('@')[0] && result.tooltip)
            void writeStored(hash, { marker, tooltip: result.tooltip });
        },
        (reason: unknown) => {
          if (started !== generation || !wanted()) return;
          const error = errorMessage(reason);
          put(
            hash,
            /^API HTTP 409\b/.test(error)
              ? { status: 'missing', marker, facts }
              : { status: 'error', error, marker, facts },
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
  rows: readonly (Omit<Wanted, 'marker'> & { marker: string | undefined })[],
  retry = false,
): Promise<void> {
  const byHash = usePublished.getState().byHash;
  const failed = (hash: number) => {
    const status = byHash[hash]?.status;
    return status === 'error' || status === 'changed';
  };
  const wanted = rows.filter(
    (row): row is Wanted =>
      row.marker !== undefined &&
      (byHash[row.hash]?.marker !== row.marker ||
        (retry && failed(row.hash)) ||
        !!row.facts?.some((fact) => !byHash[row.hash]?.facts?.includes(fact))),
  );
  if (!wanted.length) return;
  usePublished.setState((state) => {
    const next = { ...state.byHash };
    for (const { hash, marker, facts } of wanted) next[hash] = { status: 'loading', marker, facts };
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
    if (
      parsed?.success &&
      parsed.data.hash === row.hash &&
      (!row.matches || (await row.matches(parsed.data)))
    )
      hits[row.hash] = {
        status: 'ready',
        tooltip: parsed.data,
        marker: row.marker,
        facts: row.facts,
      };
    else queued.push(row);
  }
  if (started !== generation) return;
  if (Object.keys(hits).length)
    usePublished.setState((state) => {
      const next = { ...state.byHash };
      for (const [hash, entry] of Object.entries(hits))
        if (
          next[Number(hash)]?.marker === entry.marker &&
          next[Number(hash)]?.facts === entry.facts
        )
          next[Number(hash)] = entry;
      return { byHash: next };
    });
  pump();
}

/** The rows whose published text a snapshot needs: published changes (not leftovers, not new). */
export function publishedRows(
  entries: readonly Pick<PendingTooltip, 'markerOnly' | 'pushed' | 'tooltip' | 'lane'>[],
) {
  const rows = new Map<number, Wanted>();
  const lanes = new Map<number, Lane[]>();
  for (const { markerOnly, pushed, tooltip, lane } of entries) {
    const hash = lane ? lane.hash : tooltip.hash;
    const marker = lane ? lane.marker : pushed;
    if (markerOnly || hash === undefined || marker === undefined) continue;
    if (lane) lanes.set(hash, [...(lanes.get(hash) ?? []), lane]);
    rows.set(hash, { hash, marker });
  }
  for (const [hash, of] of lanes) {
    const row = rows.get(hash)!;
    row.facts = of.map(({ key, row }) =>
      row?.status === 'ready' ? `${key}:${row.english}:${row.before}` : key,
    );
    row.matches = async (tooltip) =>
      (await Promise.all(of.map((lane) => matchesLane(lane, tooltip)))).every(Boolean);
  }
  return [...rows.values()];
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
