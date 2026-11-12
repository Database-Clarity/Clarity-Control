import {
  createIndexedDbStorage,
  type DraftStorage,
  type Drafts,
} from '../../services/draftStorage';
import { mergePrefs, mergeSnapshot, type MergeOutcome } from './merge';
import {
  bucketPattern,
  isMovablePref,
  snapshotVersion,
  unownedBucket,
  type Snapshot,
} from './snapshot';

/** The browser storage the migration touches, injectable so every flow runs without a browser. */
export interface MigrateIO {
  listBuckets(): Promise<string[]>;
  open(bucket: string): DraftStorage;
  prefs: Pick<Storage, 'getItem' | 'setItem' | 'length' | 'key'>;
}

function listDraftKeys(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clarity-editor-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const keys = db.transaction('drafts', 'readonly').objectStore('drafts').getAllKeys();
      keys.onerror = () => {
        db.close();
        reject(keys.error);
      };
      keys.onsuccess = () => {
        db.close();
        resolve(keys.result.filter((key): key is string => typeof key === 'string'));
      };
    };
  });
}

export const browserIO = (): MigrateIO => ({
  listBuckets: listDraftKeys,
  open: (bucket) =>
    bucket === unownedBucket ? createIndexedDbStorage() : createIndexedDbStorage(bucket),
  prefs: localStorage,
});

export interface Collected {
  snapshot: Snapshot;
  /** Buckets that could not be read; they are left alone and reported, never dropped silently. */
  unreadable: string[];
}

export async function collectSnapshot(io: MigrateIO): Promise<Collected> {
  const buckets: Snapshot['buckets'] = {};
  const unreadable: string[] = [];
  for (const bucket of (await io.listBuckets()).filter((key) => bucketPattern.test(key))) {
    try {
      const drafts = await io.open(bucket).read();
      if (Object.keys(drafts).length) buckets[bucket] = drafts;
    } catch {
      unreadable.push(bucket);
    }
  }
  const prefs: Snapshot['prefs'] = {};
  for (let index = 0; index < io.prefs.length; index++) {
    const key = io.prefs.key(index);
    const value = key === null ? null : io.prefs.getItem(key);
    if (key !== null && value !== null && isMovablePref(key)) prefs[key] = value;
  }
  return { snapshot: { version: snapshotVersion, buckets, prefs }, unreadable };
}

async function readTargets(snapshot: Snapshot, open: (bucket: string) => DraftStorage) {
  const current: Record<string, Drafts> = {};
  for (const bucket of new Set([...Object.keys(snapshot.buckets), unownedBucket]))
    current[bucket] = await open(bucket).read();
  return current;
}

/** What a merge WOULD do, without writing anything (the confirmation screen). */
export async function previewMerge(snapshot: Snapshot, io: MigrateIO) {
  const outcome = mergeSnapshot(await readTargets(snapshot, (bucket) => io.open(bucket)), snapshot);
  return { outcome, prefs: mergePrefs((key) => io.prefs.getItem(key), snapshot.prefs) };
}

export interface ApplyResult {
  outcome: MergeOutcome;
  prefsAdded: number;
  prefsSkipped: number;
}

/**
 * Merges the snapshot into this browser. Every bucket is read first and written only through its
 * compare-and-set, so a draft another tab saved meanwhile is never overwritten (the write fails
 * and the caller reports it). Importing the same snapshot twice changes nothing the second time.
 */
export async function applySnapshot(snapshot: Snapshot, io: MigrateIO): Promise<ApplyResult> {
  const storages = new Map<string, DraftStorage>();
  const open = (bucket: string) => {
    let storage = storages.get(bucket);
    if (!storage) storages.set(bucket, (storage = io.open(bucket)));
    return storage;
  };
  const outcome = mergeSnapshot(await readTargets(snapshot, open), snapshot);
  for (const [bucket, drafts] of Object.entries(outcome.writes)) await open(bucket).write(drafts);
  const prefs = mergePrefs((key) => io.prefs.getItem(key), snapshot.prefs);
  let prefsAdded = 0;
  for (const [key, value] of Object.entries(prefs.writes)) {
    try {
      io.prefs.setItem(key, value);
      prefsAdded++;
    } catch {
      // A full or blocked localStorage only costs that preference; drafts are already stored.
    }
  }
  return { outcome, prefsAdded, prefsSkipped: prefs.skipped };
}

/**
 * Removes from THIS browser the drafts the other side confirmed it holds, but only where the
 * draft still equals what was sent (one edited since stays). Called only after an explicit click.
 */
export async function clearMoved(
  sent: Snapshot,
  stored: Record<string, string[]>,
  io: MigrateIO,
): Promise<number> {
  let removed = 0;
  for (const [bucket, hashes] of Object.entries(stored)) {
    const sentDrafts = sent.buckets[bucket];
    if (!sentDrafts || !bucketPattern.test(bucket)) continue;
    const storage = io.open(bucket);
    const current = await storage.read();
    const next = { ...current };
    for (const hash of new Set(hashes)) {
      // Own keys only: a hash such as `constructor` must never match an inherited property.
      const draft = Object.hasOwn(sentDrafts, hash) ? sentDrafts[hash] : undefined;
      if (
        draft &&
        Object.hasOwn(current, hash) &&
        JSON.stringify(current[hash]) === JSON.stringify(draft)
      ) {
        delete next[hash];
        removed++;
      }
    }
    if (Object.keys(next).length !== Object.keys(current).length) await storage.write(next);
  }
  return removed;
}
