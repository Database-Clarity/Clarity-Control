import { useMemo } from 'react';
import { changesFromTrailer, classifyInWorker, type RevisionChanges } from './scope';
import type { Tooltip } from '@clarity/core';
import { getHistory, getVersion, type HistoryCommit } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';

export interface RevisionDiffSource {
  revision: Tooltip | null;
  previous: Tooltip | null;
  hasPredecessor: boolean;
}

const PAGE_TTL = 60_000;
const MAX_PAGES = 6;
const MAX_VERSIONS = 24;
let cacheIdentity = 0;

/** Bounded LRU; failed requests are evicted and concurrent consumers share one request. */
function remember<K, V>(map: Map<K, Promise<V>>, key: K, limit: number, make: () => Promise<V>) {
  const cached = map.get(key);
  if (cached) {
    map.delete(key);
    map.set(key, cached);
    return cached;
  }
  const promise = make();
  map.set(key, promise);
  while (map.size > limit) map.delete(map.keys().next().value!);
  void promise.catch(() => {
    if (map.get(key) === promise) map.delete(key);
  });
  return promise;
}

export function createRevisionCache(hash: number) {
  const changes = new Map<string, RevisionChanges>();
  const classifications = new Map<string, Promise<RevisionChanges>>();
  const versions = new Map<string, Promise<Tooltip | null>>();
  const pages = new Map<number, Promise<HistoryCommit[]>>();
  let generation = 0;
  let running = 0;
  const waiting = new Set<() => void>();
  const acquire = (signal: AbortSignal): Promise<() => void> =>
    new Promise((resolve, reject) => {
      const abort = () => {
        waiting.delete(begin);
        reject(signal.reason);
      };
      const begin = () => {
        waiting.delete(begin);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        running++;
        resolve(() => {
          running--;
          if (running < 4) waiting.values().next().value?.();
        });
      };
      if (signal.aborted) abort();
      else if (running < 4) begin();
      else {
        waiting.add(begin);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
  const pending = new Map<AbortController, () => void>();
  const loadPending = async <T>(
    evict: () => void,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    pending.set(controller, evict);
    let release: (() => void) | undefined;
    try {
      release = await acquire(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const value = await load(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      return value;
    } finally {
      pending.delete(controller);
      release?.();
    }
  };
  const snapshots = new Map<
    number,
    { commits: HistoryCommit[]; at: number; request: Promise<HistoryCommit[]> }
  >();
  const version = (commit: string) =>
    remember(versions, commit, MAX_VERSIONS, () => {
      const request = loadPending(
        () => {
          if (versions.get(commit) === request) versions.delete(commit);
        },
        async (signal) => {
          try {
            return (await getVersion(hash, commit, signal)).tooltip;
          } catch (error) {
            // Only the Worker's explicit immutable file-absence response means a deletion.
            // Auth, routing, upstream and network failures must remain retryable errors.
            const prefix = 'API HTTP 404: ';
            if (error instanceof Error && error.message.startsWith(prefix)) {
              try {
                const body: unknown = JSON.parse(error.message.slice(prefix.length));
                if (
                  typeof body === 'object' &&
                  body !== null &&
                  'error' in body &&
                  body.error === 'Tooltip did not exist at that commit'
                )
                  return null;
              } catch {
                /* A malformed error body is not a recorded deletion. */
              }
            }
            throw error;
          }
        },
      );
      return request;
    });
  const page = (number: number) => {
    const snapshot = snapshots.get(number);
    if (
      snapshot &&
      Date.now() - snapshot.at >= PAGE_TTL &&
      pages.get(number) === snapshot.request
    ) {
      // Keep stale rows visible while replacing the expired request.
      pages.delete(number);
    }
    const request = remember(pages, number, MAX_PAGES, () =>
      loadPending(
        () => {
          if (pages.get(number) === request) pages.delete(number);
        },
        async (signal) => {
          const commits = (await getHistory(hash, number, signal)).commits;
          if (number === 1 && snapshots.get(1)?.commits[0]?.commit !== commits[0]?.commit) {
            // A new list head shifts every page boundary; bodies remain immutable.
            for (const oldPage of pages.keys()) if (oldPage !== 1) pages.delete(oldPage);
            for (const oldPage of snapshots.keys()) if (oldPage !== 1) snapshots.delete(oldPage);
          }
          if (pages.get(number) !== request) return commits;
          snapshots.set(number, { commits, at: Date.now(), request });
          while (snapshots.size > MAX_PAGES) snapshots.delete(snapshots.keys().next().value!);
          return commits;
        },
      ),
    );
    return request;
  };
  const predecessor = async (
    commits: HistoryCommit[],
    index: number,
    loadedPage: number,
    more: boolean,
  ) => {
    const next = commits[index + 1];
    if (next) return next.commit;
    if (!more) return null;
    return (await page(loadedPage + 1))[0]?.commit ?? null;
  };
  return {
    identity: ++cacheIdentity,
    classify(commits: HistoryCommit[], index: number, loadedPage: number, more: boolean) {
      const entry = commits[index];
      const hint = changesFromTrailer(entry.message, hash);
      const known = changes.get(entry.commit) ?? hint;
      if (known) return Promise.resolve(known);
      const requestedGeneration = generation;
      return remember(classifications, entry.commit, 180, async () => {
        const [revision, previous] = await Promise.all([
          version(commits[index].commit),
          predecessor(commits, index, loadedPage, more).then((commit) =>
            commit ? version(commit) : null,
          ),
        ]);
        const result = await classifyInWorker(previous, revision);
        if (requestedGeneration !== generation) throw new Error('History request cancelled');
        changes.set(commits[index].commit, result);
        while (changes.size > 180) changes.delete(changes.keys().next().value!);
        return result;
      });
    },
    peekChanges: (entry: HistoryCommit) =>
      changes.get(entry.commit) ?? changesFromTrailer(entry.message, hash),
    cancelPending() {
      generation++;
      classifications.clear();
      for (const [controller, evict] of [...pending]) {
        pending.delete(controller);
        evict();
        controller.abort();
      }
    },
    version,
    page,
    peekPage: (number: number) => snapshots.get(number)?.commits,
    async load(
      commits: HistoryCommit[],
      index: number,
      loadedPage: number,
      more: boolean,
    ): Promise<RevisionDiffSource> {
      const [revision, before] = await Promise.all([
        version(commits[index].commit),
        predecessor(commits, index, loadedPage, more).then((commit) =>
          commit
            ? version(commit).then((tooltip) => ({ tooltip, hasPredecessor: true }))
            : { tooltip: null, hasPredecessor: false },
        ),
      ]);
      return { revision, previous: before.tooltip, hasPredecessor: before.hasPredecessor };
    },
  };
}

type ScopedRevisionCache = ReturnType<typeof createRevisionCache>;
export type RevisionCache = Omit<ScopedRevisionCache, 'classify' | 'peekChanges'>;
const caches = new Map<string, ScopedRevisionCache>();
// Never reuse authenticated responses across sign-in or permission changes.
useAuthStore.subscribe((state, previous) => {
  if (state.user !== previous.user) caches.clear();
});

export function useRevisionCache(hash: number): ScopedRevisionCache {
  const user = useAuthStore((state) => state.user);
  const head = useDataStore((state) => state.data?.bundle.sourceCommit);
  return useMemo(() => {
    const key = `${user?.id}:${head}:${hash}`;
    let cache = caches.get(key);
    caches.delete(key);
    if (!cache) cache = createRevisionCache(hash);
    caches.set(key, cache);
    while (caches.size > 12) caches.delete(caches.keys().next().value!);
    return cache;
  }, [hash, user, head]);
}
