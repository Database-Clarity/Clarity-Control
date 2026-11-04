import { useMemo } from 'react';
import type { Tooltip } from '@clarity/core';
import { getHistory, getVersion, type HistoryCommit } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';

export interface RevisionDiffSource {
  revision: Tooltip;
  previous: Tooltip | null;
}

const PAGE_TTL = 60_000;
const MAX_PAGES = 6;
const MAX_VERSIONS = 24;

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
  const versions = new Map<string, Promise<Tooltip>>();
  const pages = new Map<number, Promise<HistoryCommit[]>>();
  const snapshots = new Map<
    number,
    { commits: HistoryCommit[]; at: number; request: Promise<HistoryCommit[]> }
  >();
  const version = (commit: string) =>
    remember(versions, commit, MAX_VERSIONS, async () => (await getVersion(hash, commit)).tooltip);
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
    const request = remember(pages, number, MAX_PAGES, async () => {
      const commits = (await getHistory(hash, number)).commits;
      snapshots.set(number, { commits, at: Date.now(), request });
      while (snapshots.size > MAX_PAGES) snapshots.delete(snapshots.keys().next().value!);
      return commits;
    });
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
          commit ? version(commit) : null,
        ),
      ]);
      return { revision, previous: before };
    },
  };
}

export type RevisionCache = ReturnType<typeof createRevisionCache>;
const caches = new Map<string, RevisionCache>();
// Never reuse authenticated responses across sign-in or permission changes.
useAuthStore.subscribe((state, previous) => {
  if (state.user !== previous.user) caches.clear();
});

export function useRevisionCache(hash: number): RevisionCache {
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
