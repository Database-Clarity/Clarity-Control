import { SkeletonBoundary } from '../../ui/Skeleton';
import { useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { publisherEnabled } from '../../services/publisher/flag';
import { activeHashes, usePublishState } from './publishDriver';
import { matchesFilter, queueView } from './queueModel';
import { useReviewQueue } from './queueStore';
import { ReviewQueue } from './ReviewQueue';
import { useReviewSession } from './session';
import type { PendingTooltip } from './model';
import { useDataStore } from '../../stores/data';
import { WorkThroughBar } from '../queue/WorkThroughBar';
import { reviewItem } from '../queue/reviewRows';
import { reviewStamp, type ReviewRestore } from '../queue/sources';
import styles from './ReviewQueue.module.scss';

/** Hashes inside a publish that is still queued or being sent; they cannot be picked again. */
export function useInFlight(): ReadonlySet<number> {
  const publisher = publisherEnabled();
  const ops = usePublishState((state) => state.ops);
  return useMemo(() => (publisher ? activeHashes(ops) : new Set<number>()), [ops, publisher]);
}

/** The filters' URL: keeps the open change when it still matches, else the first that does. */
export function filterParams(
  params: URLSearchParams,
  entries: readonly PendingTooltip[],
  query: string,
  category: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('marker');
  if (query) next.set('query', query);
  else next.delete('query');
  if (category) next.set('category', category);
  else next.delete('category');
  const hash = next.get('hash');
  const matching = entries.filter((entry) => matchesFilter(entry, query, category));
  if (!matching.some(({ tooltip }) => String(tooltip.hash) === hash)) {
    const first = matching.find(({ markerOnly }) => !markerOnly) ?? matching[0];
    if (first) next.set('hash', String(first.tooltip.hash));
    else next.delete('hash');
  }
  return next;
}

/** The Review left column (and the phone's list sheet): filters over the grouped queue. */
export function ReviewSidebar() {
  const entries = useReviewQueue((state) => state.entries);
  const collapsed = useReviewQueue((state) => state.collapsed);
  const markerOpen = useReviewQueue((state) => state.markerOpen);
  const pushing = useReviewSession((state) => state.pushing);
  const inFlight = useInFlight();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('query') ?? '';
  const categoryFilter = searchParams.get('category') ?? '';
  const view = useMemo(
    () => entries && queueView(entries, query, categoryFilter, collapsed, markerOpen),
    [entries, query, categoryFilter, collapsed, markerOpen],
  );
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    // Marker-only rows are one group of their own, not a category to filter by.
    for (const { categoryId, category, markerOnly } of entries ?? [])
      if (!markerOnly && !seen.has(categoryId)) seen.set(categoryId, category);
    return [...seen];
  }, [entries]);
  const data = useDataStore((state) => state.data);
  const selected = useReviewQueue((state) => state.selected);
  const anchor = useRef<HTMLDivElement>(null);
  // The rows the list shows (collapsed groups hide theirs), as queue items, in the list's order.
  const shownItems = useMemo(
    () =>
      view && data
        ? view.ordered
            .filter(({ tooltip }) => view.shown.has(tooltip.hash))
            .map((entry) => reviewItem(entry, data))
        : [],
    [view, data],
  );
  const update = (nextQuery: string, nextCategory: string) =>
    setSearchParams(filterParams(searchParams, entries ?? [], nextQuery, nextCategory), {
      replace: true,
    });
  return (
    <div className={styles.queue}>
      <SkeletonBoundary pending={entries === null} label="Loading saved changes…" shape="rows">
        {!entries?.length ? (
          <p>No saved changes are waiting to go live.</p>
        ) : (
          <>
            <div className={styles.filters}>
              <input
                type="search"
                aria-label="Find saved changes"
                placeholder="Find saved change"
                value={query}
                onChange={(event) => update(event.target.value, categoryFilter)}
              />
              <select
                data-perf-navigation="true"
                aria-label="Category"
                value={categoryFilter}
                onChange={(event) => update(query, event.target.value)}
              >
                <option value="">All categories</option>
                {categories.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div ref={anchor} className={styles.workThrough}>
              <WorkThroughBar
                source="review"
                selected={shownItems.filter((item) => selected.has(item.hash))}
                shown={shownItems}
                restore={
                  {
                    query,
                    category: categoryFilter,
                    hash: searchParams.get('hash'),
                    collapsed: [...collapsed],
                    markerOpen,
                    selected: [...selected],
                    stamps: Object.fromEntries(
                      [...selected].map((hash) => [
                        hash,
                        data ? reviewStamp(data.bundle.tooltips[hash], data.aliases) : 'gone',
                      ]),
                    ),
                  } satisfies Omit<ReviewRestore, 'scroll'>
                }
                anchor={anchor}
                dense
              />
            </div>
            {view && view.items.length ? (
              <ReviewQueue
                view={view}
                selectedHash={searchParams.get('hash')}
                locked={pushing}
                inFlight={inFlight}
              />
            ) : (
              <p className={styles.empty}>
                Nothing matches.
                <button type="button" data-perf-navigation="true" onClick={() => update('', '')}>
                  Clear filters
                </button>
              </p>
            )}
            {view && view.markerCount > 0 && !markerOpen && (
              <p className={styles.markerNote}>
                Alias-marker migration leftovers: saved content equals live. A data task clears
                these; group select never includes them.
              </p>
            )}
          </>
        )}
      </SkeletonBoundary>
    </div>
  );
}
