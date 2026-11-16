import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { publisherEnabled } from '../../services/publisher/flag';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { SkeletonRows } from '../../ui/Skeleton';
import { kindWords, useRowKinds, type Kind } from './kinds';
import { publishableHashes, type PendingTooltip } from './model';
import { activeHashes, usePublishState } from './publishDriver';
import { matchesFilter, queueView, type RowKinds } from './queueModel';
import { useReviewQueue } from './queueStore';
import { ReviewQueue } from './ReviewQueue';
import { useReviewSession } from './session';
import { BatchesList, reviewSubview } from './subview';
import { useDelayed } from './useDelayed';
import styles from './ReviewQueue.module.scss';

const count = new Intl.NumberFormat('en');

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
  kinds: RowKinds,
  query: string,
  kind: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (query) next.set('query', query);
  else next.delete('query');
  if (kind) next.set('kind', kind);
  else next.delete('kind');
  const hash = next.get('hash');
  const matching = entries.filter(
    (entry) => !entry.markerOnly && matchesFilter(entry, query, kind, kinds),
  );
  if (!matching.some(({ tooltip }) => String(tooltip.hash) === hash)) {
    const first = matching[0];
    if (first) next.set('hash', String(first.tooltip.hash));
    else next.delete('hash');
  }
  return next;
}

/**
 * "25 changes waiting to go live · 6 included · Clear" (a phone says "25 waiting"): the page's
 * head line and the phone sheet's title line.
 */
export function SelectionCounts({ changes }: { changes: number }) {
  const selected = useReviewQueue((state) => state.selected);
  const clearSelection = useReviewQueue((state) => state.clearSelection);
  const pushing = useReviewSession((state) => state.pushing);
  const entries = useReviewQueue((state) => state.entries);
  const inFlight = useInFlight();
  const included = useMemo(
    () =>
      entries
        ? entries.filter(({ tooltip }) => selected.has(tooltip.hash) && !inFlight.has(tooltip.hash))
            .length
        : 0,
    [entries, selected, inFlight],
  );
  return (
    <>
      <span className={styles.segment}>
        <b>{count.format(changes)}</b>{' '}
        <span className={styles.wideOnly}>{changes === 1 ? 'change ' : 'changes '}</span>
        waiting<span className={styles.wideOnly}> to go live</span>
      </span>
      {/* Each "·" stays with the segment after it, so a wrapped line never ends in one. */}
      {included > 0 && (
        <>
          {' '}
          <span className={styles.segment}>
            · <b>{count.format(included)}</b> included
          </span>{' '}
          <span className={styles.segment}>
            {'· '}
            <button
              type="button"
              className={styles.textButton}
              disabled={pushing}
              onClick={clearSelection}
            >
              Clear
            </button>
          </span>
        </>
      )}
    </>
  );
}

/** The Review left column (and the phone's list sheet): the Saved queue, or the batch list. */
export function ReviewSidebar() {
  const [searchParams] = useSearchParams();
  const user = useAuthStore((state) => state.user);
  if (reviewSubview(searchParams, user) === 'batches' && BatchesList)
    return (
      <Suspense fallback={null}>
        <BatchesList />
      </Suspense>
    );
  return <SavedSidebar />;
}

/** The Saved subview's left column: filters over the grouped queue, then the two quiet lines. */
function SavedSidebar() {
  const entries = useReviewQueue((state) => state.entries);
  const collapsed = useReviewQueue((state) => state.collapsed);
  const leftovers = useReviewQueue((state) => state.leftovers);
  const showLeftovers = useReviewQueue((state) => state.showLeftovers);
  const includeAll = useReviewQueue((state) => state.includeAll);
  const selected = useReviewQueue((state) => state.selected);
  const pushing = useReviewSession((state) => state.pushing);
  const drafts = useDraftStore((state) => Object.keys(state.drafts).length);
  const inFlight = useInFlight();
  const kinds = useRowKinds(entries);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('query') ?? '';
  const kind = searchParams.get('kind') ?? '';
  const view = useMemo(
    () => entries && queueView(entries, query, kind, collapsed, leftovers, kinds),
    [entries, query, kind, collapsed, leftovers, kinds],
  );
  // Each word present among the changes, with its count (leftovers are not changes).
  const present = useMemo(() => {
    const counts = new Map<Kind, number>();
    for (const entry of entries ?? []) {
      const word = kinds.get(entry.tooltip.hash);
      if (!entry.markerOnly && word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return kindWords.filter((word) => counts.has(word)).map((word) => [word, counts.get(word)!]);
  }, [entries, kinds]);
  const changes = useMemo(() => entries?.filter((entry) => !entry.markerOnly) ?? [], [entries]);
  const leftoverCount = (entries?.length ?? 0) - changes.length;
  const filtered = !!(query || kind);
  // "Include all N": the publishable changes the filters show, never leftovers or running ones.
  const shownPublishable = useMemo(
    () =>
      view && filtered ? publishableHashes(view.ordered).filter((hash) => !inFlight.has(hash)) : [],
    [view, filtered, inFlight],
  );
  const allIncluded = shownPublishable.every((hash) => selected.has(hash));
  const update = (nextQuery: string, nextKind: string) =>
    setSearchParams(filterParams(searchParams, entries ?? [], kinds, nextQuery, nextKind), {
      replace: true,
    });
  const skeleton = useDelayed(entries === null);
  if (entries === null)
    return (
      <div className={styles.queue} aria-busy="true">
        {skeleton && <SkeletonRows count={12} columns={[70, 30]} rowHeight="2rem" />}
      </div>
    );
  return (
    <div className={styles.queue}>
      <p className={styles.sheetCounts}>
        <SelectionCounts changes={changes.length} />
      </p>
      {!changes.length && leftovers === 'hidden' ? (
        <p>Nothing is waiting to go live.</p>
      ) : (
        <>
          <div className={styles.filters}>
            <span className={styles.find}>
              <input
                type="search"
                data-review-find
                aria-label="Find change"
                placeholder="Find change"
                value={query}
                onChange={(event) => update(event.target.value, kind)}
              />
              {!query && (
                <kbd aria-hidden="true" className={styles.findKey}>
                  /
                </kbd>
              )}
            </span>
            <select
              data-perf-navigation="true"
              aria-label="Kind of change"
              value={kind}
              onChange={(event) => update(query, event.target.value)}
            >
              <option value="">All kinds</option>
              {present.map(([word, n]) => (
                <option key={word} value={word}>
                  {word} ({count.format(n as number)})
                </option>
              ))}
              {kind && !present.some(([word]) => word === kind) && (
                <option value={kind}>{kind} (0)</option>
              )}
            </select>
          </div>
          {filtered && view && view.contentCount > 0 && (
            <div className={styles.listBar}>
              <span>{count.format(view.contentCount)} shown</span>
              {shownPublishable.length > 0 && (
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={pushing || allIncluded}
                  onClick={() => includeAll(shownPublishable)}
                >
                  {allIncluded
                    ? `All ${count.format(shownPublishable.length)} included`
                    : `Include all ${count.format(shownPublishable.length)}`}
                </button>
              )}
            </div>
          )}
          {view && view.items.length ? (
            <ReviewQueue
              view={view}
              kinds={kinds}
              selectedHash={searchParams.get('hash')}
              locked={pushing}
              inFlight={inFlight}
            />
          ) : (
            <p className={styles.empty}>
              No change matches.
              <button type="button" data-perf-navigation="true" onClick={() => update('', '')}>
                Clear filters
              </button>
            </p>
          )}
        </>
      )}
      {((leftoverCount > 0 && leftovers === 'hidden') || drafts > 0) && (
        <div className={styles.footer}>
          {leftoverCount > 0 && leftovers === 'hidden' && (
            <p>
              {count.format(leftoverCount)} migration{' '}
              {leftoverCount === 1 ? 'leftover' : 'leftovers'} hidden: their text already matches
              live.{' '}
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  showLeftovers();
                  if (kind) update(query, '');
                }}
              >
                Show
              </button>
            </p>
          )}
          {drafts > 0 && (
            <p>
              {count.format(drafts)} unsaved {drafts === 1 ? 'draft is' : 'drafts are'} not listed.{' '}
              <button
                type="button"
                className={styles.textButton}
                onClick={() =>
                  document.querySelector<HTMLButtonElement>('[data-drafts-button]')?.click()
                }
              >
                Open drafts
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
