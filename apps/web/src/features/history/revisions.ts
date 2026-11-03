import { useRef } from 'react';
import type { Tooltip } from '@clarity/core';
import { getHistory, getVersion, type HistoryCommit } from '../../services/history';

export interface RevisionDiffSource {
  revision: Tooltip;
  /** The previous revision; null when this one created the tooltip. */
  previous: Tooltip | null;
}

/**
 * Lazily fetched, cached revision bodies for one tooltip. Promises are cached (so two opens of the
 * same entry share one request) and dropped when they fail, so a retry asks again.
 */
export function createRevisionCache(hash: number) {
  const versions = new Map<string, Promise<Tooltip>>();
  const pages = new Map<number, Promise<HistoryCommit[]>>();
  const remember = <K, V>(map: Map<K, Promise<V>>, key: K, make: () => Promise<V>) => {
    const cached = map.get(key);
    if (cached) return cached;
    const promise = make();
    map.set(key, promise);
    promise.catch(() => map.delete(key));
    return promise;
  };
  const version = (commit: string) =>
    remember(versions, commit, async () => (await getVersion(hash, commit)).tooltip);
  const page = (number: number) =>
    remember(pages, number, async () => (await getHistory(hash, number)).commits);
  /** The commit before `commits[index]`; the next page is asked for only at a page's last entry. */
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

export function useRevisionCache(hash: number): RevisionCache {
  const holder = useRef<{ hash: number; cache: RevisionCache } | undefined>(undefined);
  if (holder.current?.hash !== hash) holder.current = { hash, cache: createRevisionCache(hash) };
  return holder.current.cache;
}
