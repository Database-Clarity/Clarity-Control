import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import {
  canPush,
  pendingTooltips,
  preparedPending,
  publishableHashes,
  selectedPending,
  sidebarChanges,
  stepIndex,
  toggleSelection,
  type PendingTooltip,
} from './model';
import { PushConfirm } from './PushConfirm';
import { ReviewDetail } from './ReviewDetail';
import { ReviewRow } from './ReviewRow';
import { acknowledgedMarkers, publishReviewed, useReviewSession } from './session';
import { publisherEnabled } from '../../services/publisher/flag';
import { PublishActivity } from './PublishActivity';
import { queuePublish } from './publishAction';
import { publishDriver } from './publisher';
import { activeHashes, usePublishState } from './publishDriver';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import styles from './Review.module.scss';
import { advanceReviewOpening, retainReviewPage, useReviewOpening } from './opening';

// Keep the first page close to one viewport; every row is fully rendered, and
// the existing page controls expose the rest without offscreen layout on open.
const pageSize = 5;

export function ReviewPage() {
  const opening = useReviewOpening((state) => state.warming);
  const openingToken = useReviewOpening((state) => state.token);
  const article = useRef<HTMLElement>(null);
  const queuedSteps = useRef(0);
  useLayoutEffect(retainReviewPage, []);
  useLayoutEffect(() => {
    if (article.current) article.current.inert = opening;
  }, [opening]);
  useLayoutEffect(() => {
    const state = useReviewOpening.getState();
    if (!state.warming || state.token !== openingToken || !window.requestAnimationFrame) return;
    let frame: number | undefined;
    let timer: number | undefined;
    let alive = true;
    // Schedule before the first paint; a passive effect can miss its frame
    // and leave an unnecessary idle frame before the bounded row slices.
    let first = true;
    const next = () => {
      frame = requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          if (!alive) return;
          if (first) {
            performance.mark?.('review:opening-painted', {
              detail: { token: openingToken, route: location.hash },
            });
            first = false;
          }
          if (!advanceReviewOpening(openingToken)) next();
        }, 0);
      });
    };
    next();
    return () => {
      alive = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [openingToken]);
  useEffect(() => {
    const state = useReviewOpening.getState();
    if (opening || state.warming || state.token !== openingToken || !window.requestAnimationFrame)
      return;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        const current = useReviewOpening.getState();
        if (
          !article.current?.isConnected ||
          current.warming ||
          current.token !== openingToken ||
          !location.hash.startsWith('#/review')
        )
          return;
        performance.mark?.('review:interactive', {
          detail: { token: openingToken, route: location.hash },
        });
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [opening, openingToken]);
  const [searchParams, setSearchParams] = useSearchParams();
  const data = useDataStore((state) => state.data);
  const load = useDataStore((state) => state.load);
  const user = useAuthStore((state) => state.user);
  const drafts = useDraftStore((state) => state.drafts);
  const setSidebarChanges = useSidebarQueueStore((state) => state.setPendingChanges);
  const { pushing, notice, error: pushError, acknowledgments } = useReviewSession();
  const prepared = useMemo(
    () => (data && !Object.keys(acknowledgments).length ? preparedPending(data) : undefined),
    [data, acknowledgments],
  );
  const [entries, setEntries] = useState<PendingTooltip[]>(prepared ?? []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // What the confirm dialog lists is exactly what gets pushed, from the snapshot it was opened on.
  const [confirming, setConfirming] = useState<{ entries: PendingTooltip[]; data: EditorData }>();
  const [loading, setLoading] = useState(!prepared);
  const query = searchParams.get('query') ?? '';
  const categoryFilter = searchParams.get('category') ?? '';
  const publisher = publisherEnabled();
  const ops = usePublishState((state) => state.ops);
  // Hashes inside a publish that is still queued or being sent; cannot be picked again.
  const inFlight = useMemo(
    () => (publisher ? activeHashes(ops) : new Set<number>()),
    [ops, publisher],
  );
  useEffect(() => {
    // Pick up operations another tab started and anything now due, whenever this page opens.
    if (publisher) void publishDriver.refresh();
  }, [publisher]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    if (!data) return;
    // The initial snapshot was already checked against these exact saved
    // markers. Rechecking and cloning thousands of markers in the mount effect
    // repeats that work before the first workspace paint.
    if (prepared) {
      setEntries(prepared);
      setLoading(false);
      setSelected((previous) => (previous.size ? new Set() : previous));
      return;
    }
    const markers = acknowledgedMarkers(data);
    const ready = preparedPending(data, markers);
    setLoading(!ready);
    if (ready) setEntries(ready);
    setSelected((previous) => (previous.size ? new Set() : previous));
    if (ready) return;
    void pendingTooltips(data, markers).then(
      (result) => {
        if (!active) return;
        setEntries(result);
        setLoading(false);
      },
      (reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [data, acknowledgments, prepared]);
  const visibleEntries = useMemo(
    () =>
      !categoryFilter && !query
        ? entries
        : entries.filter(
            ({ name, category, categoryId, tooltip }) =>
              (!categoryFilter || categoryId === categoryFilter) &&
              (!query ||
                `${name} ${category} ${categoryId} ${tooltip.hash}`
                  .toLowerCase()
                  .includes(query.toLowerCase())),
          ),
    [entries, categoryFilter, query],
  );
  const categories = useMemo(
    () =>
      [
        ...new Map(
          entries.map(({ category, categoryId }) => [
            categoryId,
            { id: categoryId, label: category },
          ]),
        ).values(),
      ].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    [entries],
  );
  const routedHash = searchParams.get('hash');
  const routedIndex =
    routedHash === null
      ? -1
      : visibleEntries.findIndex(({ tooltip }) => String(tooltip.hash) === routedHash);
  const index = routedIndex < 0 ? 0 : routedIndex;
  const selectIndex = useCallback(
    (next: number | ((current: number) => number)) => {
      if (!visibleEntries.length) return;
      const requested = typeof next === 'function' ? next(index) : next;
      const entry = visibleEntries[stepIndex(requested, 0, visibleEntries.length)];
      if (!entry || searchParams.get('hash') === String(entry.tooltip.hash)) return;
      const params = new URLSearchParams(searchParams);
      params.set('hash', String(entry.tooltip.hash));
      setSearchParams(params, { replace: true });
    },
    [index, searchParams, setSearchParams, visibleEntries],
  );
  const openCurrentRow = useCallback(
    (hash: number) => {
      const next = visibleEntries.findIndex((entry) => entry.tooltip.hash === hash);
      if (next >= 0) selectIndex(next);
    },
    [selectIndex, visibleEntries],
  );
  const committedRowOpen = useRef(openCurrentRow);
  useLayoutEffect(() => {
    // Retained row handlers must use the filters and URL from the committed UI.
    committedRowOpen.current = openCurrentRow;
  }, [openCurrentRow]);
  const openRow = useCallback((hash: number) => committedRowOpen.current(hash), []);
  const toggleRow = useCallback(
    (hash: number) => setSelected((previous) => toggleSelection(previous, hash)),
    [],
  );
  useEffect(() => {
    if (loading) return;
    setSidebarChanges(sidebarChanges(entries));
  }, [entries, loading, setSidebarChanges]);
  useEffect(() => {
    if (loading) return;
    const current = visibleEntries[index];
    const params = new URLSearchParams(searchParams);
    if (!current) {
      if (!params.has('hash')) return;
      params.delete('hash');
      setSearchParams(params, { replace: true });
      return;
    }
    if (searchParams.get('hash') === String(current.tooltip.hash)) return;
    params.set('hash', String(current.tooltip.hash));
    setSearchParams(params, { replace: true });
  }, [index, loading, searchParams, setSearchParams, visibleEntries]);
  useEffect(() => {
    setSelected((previous) => (previous.size ? new Set() : previous));
  }, [user]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (workspaceShortcutsBlocked(event)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || pushing) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, button, a, [contenteditable="true"]')
      )
        return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (opening) {
        queuedSteps.current += event.key === 'ArrowDown' ? 1 : -1;
        return;
      }
      selectIndex((value) =>
        stepIndex(value, event.key === 'ArrowDown' ? 1 : -1, visibleEntries.length),
      );
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [opening, pushing, selectIndex, visibleEntries.length]);
  useEffect(() => {
    if (opening || pushing || !queuedSteps.current) return;
    const steps = queuedSteps.current;
    queuedSteps.current = 0;
    const focus = document.activeElement;
    if (focus && focus !== document.body && !article.current?.contains(focus)) return;
    selectIndex((value) => stepIndex(value, steps, visibleEntries.length));
  }, [opening, pushing, selectIndex, visibleEntries.length]);
  const hashes = selected.size
    ? selectedPending(selected, entries).filter((hash) => !inFlight.has(hash))
    : [];
  const start = Math.floor(index / pageSize) * pageSize;
  const page = visibleEntries.slice(start, start + pageSize);
  const groups = [...new Set(page.map((entry) => entry.categoryId))];

  function updateFilters(queryValue: string, categoryValue: string) {
    const params = new URLSearchParams(searchParams);
    if (queryValue) params.set('query', queryValue);
    else params.delete('query');
    if (categoryValue) params.set('category', categoryValue);
    else params.delete('category');
    const matching = entries.filter(
      ({ name, category, categoryId, tooltip }) =>
        (!categoryValue || categoryId === categoryValue) &&
        (!queryValue ||
          `${name} ${category} ${categoryId} ${tooltip.hash}`
            .toLowerCase()
            .includes(queryValue.toLowerCase())),
    );
    const currentHash = params.get('hash');
    if (!matching.some(({ tooltip }) => String(tooltip.hash) === currentHash)) {
      if (matching[0]) params.set('hash', String(matching[0].tooltip.hash));
      else params.delete('hash');
    }
    setSearchParams(params, { replace: true });
  }

  function askToPublish() {
    if (!data || loading || pushing) return;
    const chosen = entries.filter(({ tooltip }) => hashes.includes(tooltip.hash));
    if (chosen.length) setConfirming({ entries: chosen, data });
  }

  async function publish({ entries: chosen, data: reviewed }: NonNullable<typeof confirming>) {
    setConfirming(undefined);
    setError(undefined);
    const succeeded = await (publisher ? queuePublish : publishReviewed)(
      chosen,
      reviewed,
      () => mounted.current,
    );
    if (succeeded && mounted.current) setSelected(new Set());
  }

  return (
    <>
      <p role="status" className={opening ? styles.openingStatus : styles.readyStatus}>
        {opening ? 'Opening Review…' : 'Review ready.'}
      </p>
      <article
        ref={article}
        aria-busy={loading || opening}
        className={opening ? styles.opening : undefined}
      >
        <fieldset
          className={styles.openingControls}
          disabled={opening}
          aria-hidden={opening || undefined}
        >
          <header className={styles.heading}>
            <h1>Review changes</h1>
            <p>
              Saved changes waiting to go live, grouped by category. Use Up/Down outside controls,
              or Previous/Next, to walk through them.
            </p>
          </header>
          {Object.keys(drafts).length > 0 && (
            <p>Local drafts are not included. Save them through the tooltip editor first.</p>
          )}
          {(!apiUrl || !user?.role) && (
            <p className={styles.authNotice} role="note">
              {apiUrl
                ? 'Sign in as a configured member to compare live versions and browse history. Only editors and maintainers may push.'
                : 'Live comparison and history need a configured API. Saved changes remain local.'}
            </p>
          )}
          {confirming && (
            <PushConfirm
              entries={confirming.entries}
              background={publisher}
              onConfirm={() => void publish(confirming)}
              onCancel={() => setConfirming(undefined)}
            />
          )}
          {error && <p role="alert">{error}</p>}
          {pushError && <p role="alert">{pushError}</p>}
          {notice && <p role="status">{notice}</p>}
          {publisher && canPush(user) && <PublishActivity queue={data?.bundle.publishQueue} />}
          <div className={styles.toolbar}>
            <button type="button" disabled={pushing || loading} onClick={() => void load()}>
              Refresh saved changes
            </button>
            <span>
              {entries.length} pending / {hashes.length} selected
            </span>
            {canPush(user) && (
              <button
                type="button"
                disabled={pushing || loading || !hashes.length}
                onClick={askToPublish}
              >
                {publisher
                  ? pushing
                    ? 'Starting...'
                    : 'Publish selected'
                  : pushing
                    ? 'Pushing...'
                    : 'Push selected'}
              </button>
            )}
          </div>
          {!!entries.length && (
            <div className={styles.filters}>
              <label>
                Find saved changes
                <input
                  type="search"
                  aria-label="Find saved changes"
                  value={query}
                  onChange={(event) => updateFilters(event.target.value, categoryFilter)}
                  placeholder="Name, category or hash"
                />
              </label>
              <label>
                Category
                <select
                  data-perf-navigation="true"
                  aria-label="Category"
                  value={categoryFilter}
                  onChange={(event) => updateFilters(query, event.target.value)}
                >
                  <option value="">All categories</option>
                  {categories.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label} · {id}
                    </option>
                  ))}
                </select>
              </label>
              <span>
                Showing {visibleEntries.length} of {entries.length}
              </span>
            </div>
          )}
          {loading ? (
            <p role="status">Comparing publishable content...</p>
          ) : !entries.length ? (
            <p>No saved changes are waiting to go live.</p>
          ) : !visibleEntries.length ? (
            <section className={styles.empty}>
              <p>No saved changes match these filters.</p>
              <button
                type="button"
                data-perf-navigation="true"
                onClick={() => updateFilters('', '')}
              >
                Clear filters
              </button>
            </section>
          ) : (
            <>
              <div className={styles.toolbar}>
                <button
                  type="button"
                  disabled={!index || pushing}
                  data-perf-navigation="true"
                  onClick={() =>
                    selectIndex((value) => stepIndex(value, -1, visibleEntries.length))
                  }
                >
                  Previous
                </button>
                <span>
                  {index + 1} of {visibleEntries.length}
                </span>
                <button
                  type="button"
                  disabled={index >= visibleEntries.length - 1 || pushing}
                  data-perf-navigation="true"
                  onClick={() => selectIndex((value) => stepIndex(value, 1, visibleEntries.length))}
                >
                  Next
                </button>
              </div>
              <div className={styles.workspace}>
                <section className={styles.card} aria-label="Pending changes">
                  <header className={styles.listHeading}>
                    <h2>Pending changes</h2>
                    <div className={styles.toolbar}>
                      <button
                        type="button"
                        disabled={pushing}
                        onClick={() =>
                          setSelected(
                            (previous) =>
                              new Set([
                                ...previous,
                                ...publishableHashes(page).filter((hash) => !inFlight.has(hash)),
                              ]),
                          )
                        }
                      >
                        Select page
                      </button>
                      <button
                        type="button"
                        disabled={pushing}
                        onClick={() => setSelected(new Set())}
                      >
                        Clear selection
                      </button>
                    </div>
                  </header>
                  {groups.map((categoryId) => {
                    const category = page.find((entry) => entry.categoryId === categoryId)!;
                    return (
                      <section key={categoryId} aria-label={`${category.category} (${categoryId})`}>
                        <h3 className={styles.categoryHeading}>
                          {category.category} <small>· {categoryId}</small>
                        </h3>
                        <ul className={styles.list}>
                          {page
                            .filter((entry) => entry.categoryId === categoryId)
                            .map((entry) => (
                              <ReviewRow
                                key={entry.tooltip.hash}
                                entry={entry}
                                checked={selected.has(entry.tooltip.hash)}
                                active={visibleEntries[index]?.tooltip.hash === entry.tooltip.hash}
                                disabled={pushing}
                                publishing={inFlight.has(entry.tooltip.hash)}
                                historyAvailable={Boolean(apiUrl && user?.role)}
                                onToggle={toggleRow}
                                onOpen={openRow}
                              />
                            ))}
                        </ul>
                      </section>
                    );
                  })}
                  <div className={styles.toolbar}>
                    <button
                      type="button"
                      disabled={!start || pushing}
                      data-perf-navigation="true"
                      onClick={() => selectIndex(start - pageSize)}
                    >
                      Previous page
                    </button>
                    <button
                      type="button"
                      disabled={start + pageSize >= visibleEntries.length || pushing}
                      data-perf-navigation="true"
                      onClick={() => selectIndex(start + pageSize)}
                    >
                      Next page
                    </button>
                  </div>
                </section>
                {visibleEntries[index] && user?.role && apiUrl && (
                  <div className={styles.card}>
                    <ReviewDetail
                      key={visibleEntries[index].tooltip.hash}
                      entry={visibleEntries[index]}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </fieldset>
      </article>
    </>
  );
}
