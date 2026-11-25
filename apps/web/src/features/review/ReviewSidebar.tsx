import { Suspense, useContext, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { publisherEnabled } from '../../services/publisher/flag';
import { useAuthStore } from '../../stores/auth';
import { FinderSheetCloseContext, FinderSheetContext } from '../navigation/FinderSheetContext';
import { useDraftStore } from '../../stores/drafts';
import { SkeletonRows } from '../../ui/Skeleton';
import { languageLabel } from '../../languageLabels';
import { canPublishTranslations, publishLanguages } from '../auth/permissions';
import { isFolded, rowKey } from './globalRows';
import { kindWords, rowKinds, useKinds, useRowKinds, type Kind } from './kinds';
import { canPush, publishableHashes, type PendingTooltip } from './model';
import { globalKey } from './globalsPending';
import { filteredLanguage, inLanguage } from './lanes';
import { activeGlobals, activeHashes, activeTranslations, usePublishState } from './publishDriver';
import { matchesFilter, queueView, type RowKinds } from './queueModel';
import { usePublished } from './published';
import { useReviewQueue } from './queueStore';
import { ReviewQueue } from './ReviewQueue';
import { useReviewSession } from './session';
import { BatchesList, reviewSubview } from './subview';
import { useDelayed } from './useDelayed';
import styles from './ReviewQueue.module.scss';

const count = new Intl.NumberFormat('en');
const noEntries: PendingTooltip[] = [];

/** Rows inside a publish that is still queued or being sent; they cannot be picked again. */
export function useInFlight(): ReadonlySet<number> {
  const publisher = publisherEnabled();
  const ops = usePublishState((state) => state.ops);
  return useMemo(
    () =>
      publisher
        ? new Set([
            ...activeHashes(ops),
            ...[...activeGlobals(ops), ...activeTranslations(ops)].map(globalKey),
          ])
        : new Set<number>(),
    [ops, publisher],
  );
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
  const open = next.get('hash');
  const matching = entries.filter(
    (entry) => !isFolded(entry) && matchesFilter(entry, query, kind, kinds),
  );
  if (!matching.some((entry) => String(rowKey(entry)) === open)) {
    const first = matching[0];
    if (first) next.set('hash', String(rowKey(first)));
    else next.delete('hash');
  }
  return next;
}

/** What the counts say: a translator's blocked rows are listed, but not ready. */
export const readyCount = (changes: readonly PendingTooltip[]) =>
  changes.filter(({ lane, unpublishable }) => !lane || !unpublishable).length;

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
  const translator = useAuthStore((state) => canPublishTranslations(state.user));
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
        {translator ? 'ready' : 'waiting'}
        <span className={styles.wideOnly}> to go live</span>
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
  const inSheet = Boolean(useContext(FinderSheetCloseContext));
  const sheetOpen = useContext(FinderSheetContext);
  if (reviewSubview(searchParams, user) === 'batches' && BatchesList) {
    if (inSheet && !sheetOpen) return null;
    return (
      <Suspense fallback={null}>
        <BatchesList phone={inSheet} />
      </Suspense>
    );
  }
  return <SavedSidebar />;
}

/** The Saved subview's left column: filters over the grouped queue, then the two quiet lines. */
function SavedSidebar() {
  const entries = useReviewQueue((state) => state.entries);
  const collapsed = useReviewQueue((state) => state.collapsed);
  const leftovers = useReviewQueue((state) => state.leftovers);
  const showLeftovers = useReviewQueue((state) => state.showLeftovers);
  const translations = useReviewQueue((state) => state.translations);
  const showTranslations = useReviewQueue((state) => state.showTranslations);
  const includeAll = useReviewQueue((state) => state.includeAll);
  const selected = useReviewQueue((state) => state.selected);
  const pushing = useReviewSession((state) => state.pushing);
  const drafts = useDraftStore((state) => Object.keys(state.drafts).length);
  const inFlight = useInFlight();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const languages = publishLanguages(user);
  // A translator of several languages filters by language; the rows then name theirs.
  const language = filteredLanguage(searchParams, languages) ?? '';
  const rows = inLanguage(entries ?? noEntries, language || undefined);
  const kinds = useRowKinds(rows);
  const query = searchParams.get('query') ?? '';
  const kind = searchParams.get('kind') ?? '';
  const view = useMemo(
    () => entries && queueView(rows, query, kind, collapsed, leftovers, kinds, translations),
    [entries, rows, query, kind, collapsed, leftovers, kinds, translations],
  );
  // Each word present among the changes, with its count (leftovers are not changes).
  const present = useMemo(() => {
    const files = new Map<Kind, Set<number>>();
    for (const entry of rows) {
      const word = kinds.get(rowKey(entry));
      if (isFolded(entry) || !word) continue;
      const hashes = files.get(word);
      if (hashes) hashes.add(entry.tooltip.hash);
      else files.set(word, new Set([entry.tooltip.hash]));
    }
    return kindWords.filter((word) => files.has(word)).map((word) => [word, files.get(word)!.size]);
  }, [rows, kinds]);
  const changes = useMemo(() => entries?.filter((entry) => !isFolded(entry)) ?? [], [entries]);
  const leftoverCount = useMemo(
    () => entries?.filter(({ markerOnly }) => markerOnly).length ?? 0,
    [entries],
  );
  const translationCount = (entries?.length ?? 0) - changes.length - leftoverCount;
  const hiddenLeftovers = leftovers === 'hidden' ? leftoverCount : 0;
  const hiddenTranslations = translations === 'hidden' ? translationCount : 0;
  const filtered = !!(query || kind || language);
  // The changes on screen: the filters' rows outside collapsed groups (never leftovers).
  const shownChanges = useMemo(
    () =>
      view && filtered
        ? view.ordered.filter((entry) => !isFolded(entry) && view.shown.has(rowKey(entry)))
        : [],
    [view, filtered],
  );
  // "Include all N": exactly the publishable changes shown, never running ones; only for a role
  // that can publish.
  const shownPublishable = useMemo(
    () =>
      canPush(user) || canPublishTranslations(user)
        ? publishableHashes(shownChanges).filter((hash) => !inFlight.has(hash))
        : [],
    [shownChanges, inFlight, user],
  );
  const allIncluded = shownPublishable.every((hash) => selected.has(hash));
  const update = (nextQuery: string, nextKind: string, nextLanguage = language) => {
    const params = new URLSearchParams(searchParams);
    if (nextLanguage) params.set('lang', nextLanguage);
    else params.delete('lang');
    const shown = inLanguage(entries ?? noEntries, nextLanguage || undefined);
    setSearchParams(
      filterParams(
        params,
        shown,
        shown === rows
          ? kinds
          : rowKinds(shown, usePublished.getState().byHash, useKinds.getState().byHash),
        nextQuery,
        nextKind,
      ),
      { replace: true },
    );
  };
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
        <SelectionCounts changes={readyCount(changes)} />
      </p>
      {!changes.length && !view?.items.length && !filtered ? (
        <p>Nothing is waiting to go live.</p>
      ) : (
        <>
          <div className={styles.filters} data-languages={languages.length > 1 || undefined}>
            <span className={styles.find}>
              <input
                type="search"
                data-review-find
                aria-label="Find change"
                placeholder="Find change"
                value={query}
                onChange={(event) => update(event.target.value, kind)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !query) return;
                  // Clear Find before Escape can dismiss the phone's list sheet.
                  event.preventDefault();
                  event.stopPropagation();
                  update('', kind);
                }}
              />
              {!query && (
                <kbd aria-hidden="true" className={styles.findKey}>
                  /
                </kbd>
              )}
            </span>
            {languages.length > 1 && (
              <select
                data-perf-navigation="true"
                aria-label="Language"
                value={language}
                onChange={(event) => update(query, kind, event.target.value)}
              >
                <option value="">All languages</option>
                {languages.map((lang) => (
                  <option key={lang} value={lang}>
                    {languageLabel(lang)} (
                    {count.format(readyCount(changes.filter(({ lane }) => lane?.lang === lang)))})
                  </option>
                ))}
              </select>
            )}
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
          {shownChanges.length > 0 && (
            <div className={styles.listBar}>
              <span>{count.format(shownChanges.length)} shown</span>
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
              languages={languages.length > 1}
            />
          ) : (
            <p className={styles.empty}>
              No change matches.
              <button type="button" data-perf-navigation="true" onClick={() => update('', '', '')}>
                Clear filters
              </button>
            </p>
          )}
        </>
      )}
      {(hiddenLeftovers > 0 || hiddenTranslations > 0 || drafts > 0) && (
        <div className={styles.footer}>
          {hiddenTranslations > 0 && (
            <p>
              {count.format(hiddenTranslations)}{' '}
              {hiddenTranslations === 1 ? 'translation' : 'translations'} hidden: translators
              publish {hiddenTranslations === 1 ? 'it' : 'them'}.{' '}
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  showTranslations();
                  if (kind) update(query, '');
                }}
              >
                Show
              </button>
            </p>
          )}
          {hiddenLeftovers > 0 && (
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
