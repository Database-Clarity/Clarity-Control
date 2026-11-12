import { SkeletonBoundary } from '../../ui/Skeleton';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import {
  canPush,
  pendingTooltips,
  preparedPending,
  publishSidebar,
  selectedPending,
  type PendingTooltip,
} from './model';
import { PushConfirm } from './PushConfirm';
import { ReviewDetail } from './ReviewDetail';
import { acknowledgedMarkers, publishReviewed, useReviewSession } from './session';
import { publisherEnabled } from '../../services/publisher/flag';
import { PublishActivity } from './PublishActivity';
import { queuePublish } from './publishAction';
import { publishDriver } from './publisher';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { changeMarks } from './changedFields';
import { useReviewMarks } from './reviewMarks';
import { queueView, stepRow } from './queueModel';
import { useReviewQueue } from './queueStore';
import { filterParams, useInFlight } from './ReviewSidebar';
import styles from './Review.module.scss';
import {
  advanceReviewOpening,
  readyReviewData,
  retainReviewPage,
  useReviewOpening,
} from './opening';

const count = new Intl.NumberFormat('en');

export function ReviewPage() {
  const opening = useReviewOpening((state) => state.warming);
  const openingToken = useReviewOpening((state) => state.token);
  const article = useRef<HTMLElement>(null);
  useLayoutEffect(retainReviewPage, []);
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
  const routeLocation = useLocation();
  const selectionIntent = useRef<{ params: URLSearchParams; targets: Set<string> }>();
  useLayoutEffect(() => {
    const intent = selectionIntent.current;
    if (!intent) return;
    const committed = searchParams.toString();
    // An older queued selection can commit before the latest one. Retain the
    // latest intent until it commits, or an external URL/Back navigation wins.
    if (committed === intent.params.toString() || !intent.targets.delete(committed))
      selectionIntent.current = undefined;
  }, [searchParams, routeLocation.key]);
  const data = useDataStore((state) => state.data);
  const load = useDataStore((state) => state.load);
  const user = useAuthStore((state) => state.user);
  const drafts = useDraftStore((state) => state.drafts);
  const { pushing, notice, error: pushError, acknowledgments } = useReviewSession();
  const prepared = useMemo(
    () => (data && !Object.keys(acknowledgments).length ? preparedPending(data) : undefined),
    [data, acknowledgments],
  );
  const [entries, setEntries] = useState<PendingTooltip[]>(prepared ?? []);
  const selected = useReviewQueue((state) => state.selected);
  const toggleRow = useReviewQueue((state) => state.toggle);
  const clearSelection = useReviewQueue((state) => state.clearSelection);
  const collapsed = useReviewQueue((state) => state.collapsed);
  const markerOpen = useReviewQueue((state) => state.markerOpen);
  const openMarkers = useReviewQueue((state) => state.openMarkers);
  // What the confirm dialog lists is exactly what gets pushed, from the snapshot it was opened on.
  const [confirming, setConfirming] = useState<{ entries: PendingTooltip[]; data: EditorData }>();
  const [loading, setLoading] = useState(!prepared);
  useLayoutEffect(() => readyReviewData(!loading), [loading]);
  const query = searchParams.get('query') ?? '';
  const categoryFilter = searchParams.get('category') ?? '';
  const publisher = publisherEnabled();
  const inFlight = useInFlight();
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
      clearSelection();
      return;
    }
    const markers = acknowledgedMarkers(data);
    const ready = preparedPending(data, markers);
    setLoading(!ready);
    if (ready) setEntries(ready);
    clearSelection();
    if (ready) return;
    void pendingTooltips(data, markers).then(
      (result) => {
        if (!active) return;
        setEntries(result);
        // The list kept showing the previous snapshot while this one was compared: nothing picked
        // there may carry over to saved text nobody has looked at.
        clearSelection();
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
  }, [data, acknowledgments, prepared, clearSelection]);
  const view = useMemo(
    () => queueView(entries, query, categoryFilter, collapsed, markerOpen),
    [entries, query, categoryFilter, collapsed, markerOpen],
  );
  const { ordered } = view;
  const changeCount = useMemo(
    () => entries.filter(({ markerOnly }) => !markerOnly).length,
    [entries],
  );
  const markerTotal = entries.length - changeCount;
  const routedHash = searchParams.get('hash');
  const routedIndex =
    routedHash === null
      ? -1
      : ordered.findIndex(({ tooltip }) => String(tooltip.hash) === routedHash);
  // `marker=1` (the header's marker-only link) opens the group's first row.
  const markerRequest = searchParams.get('marker') === '1' && routedIndex < 0;
  // Without a route or request, open the first change a person made; marker-only leftovers open
  // only when asked for (the header link, or a URL naming one), never as a default.
  const index =
    routedIndex >= 0
      ? routedIndex
      : markerRequest && view.markerCount
        ? view.contentCount
        : view.contentCount
          ? 0
          : -1;
  const current = index < 0 ? undefined : ordered[index];
  // Moving the selection onto a marker-only row (URL, Back/Forward, the header link) shows its
  // collapsed group; collapsing it again while that row stays open is left alone.
  const previousHash = useRef<number>();
  useEffect(() => {
    const hash = current?.tooltip.hash;
    if (hash === previousHash.current) return;
    previousHash.current = hash;
    if (current?.markerOnly) openMarkers();
  }, [current, openMarkers]);
  const selectIndex = useCallback(
    (step: (current: number) => number) => {
      if (!ordered.length) return;
      const intent = selectionIntent.current;
      const params = new URLSearchParams(intent?.params ?? searchParams);
      const pendingIndex = intent
        ? ordered.findIndex(({ tooltip }) => String(tooltip.hash) === params.get('hash'))
        : -1;
      const entry = ordered[step(pendingIndex < 0 ? index : pendingIndex)];
      if (!entry || params.get('hash') === String(entry.tooltip.hash)) return;
      params.delete('marker');
      params.set('hash', String(entry.tooltip.hash));
      const targets = intent?.targets ?? new Set<string>();
      targets.add(params.toString());
      selectionIntent.current = { params, targets };
      setSearchParams(params, { replace: true });
    },
    [index, ordered, searchParams, setSearchParams],
  );
  const shortcuts = useRef<(action: 'include' | 'publish') => void>(() => {});
  const committedSelectIndex = useRef(selectIndex);
  const committedView = useRef(view);
  useLayoutEffect(() => {
    // Window listeners can run after a commit but before passive effects bind
    // a new closure. Use that commit's selection alongside any queued intent.
    committedSelectIndex.current = selectIndex;
    committedView.current = view;
  }, [selectIndex, view]);
  useEffect(() => {
    if (loading) return;
    publishSidebar(entries);
  }, [entries, loading]);
  useEffect(() => {
    if (loading || selectionIntent.current) return;
    const params = new URLSearchParams(searchParams);
    if (!current) {
      if (!params.has('hash') && !params.has('marker')) return;
      params.delete('hash');
      params.delete('marker');
      setSearchParams(params, { replace: true });
      return;
    }
    if (searchParams.get('hash') === String(current.tooltip.hash) && !params.has('marker')) return;
    params.delete('marker');
    params.set('hash', String(current.tooltip.hash));
    setSearchParams(params, { replace: true });
  }, [current, loading, searchParams, setSearchParams]);
  useEffect(() => clearSelection(), [user, clearSelection]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || workspaceShortcutsBlocked(event)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || pushing) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, button, a, [contenteditable="true"], [aria-label="Scroll pending saved changes"]',
        )
      )
        return;
      if (event.key === ' ' || event.key.toLowerCase() === 'p') {
        // Space includes the open change in the publish; P opens the publish confirmation.
        event.preventDefault();
        shortcuts.current(event.key === ' ' ? 'include' : 'publish');
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      committedSelectIndex.current((value) => stepRow(committedView.current, value, delta));
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [pushing]);
  const hashes = selected.size
    ? selectedPending(selected, entries).filter((hash) => !inFlight.has(hash))
    : [];

  function askToPublish() {
    if (!data || loading || pushing) return;
    const chosen = entries.filter(({ tooltip }) => hashes.includes(tooltip.hash));
    if (chosen.length) setConfirming({ entries: chosen, data });
  }
  shortcuts.current = (action) => {
    if (action === 'publish') {
      if (canPush(user) && hashes.length) askToPublish();
    } else if (current && !pushing && !current.unpublishable && !inFlight.has(current.tooltip.hash))
      toggleRow(current.tooltip.hash);
  };

  async function publish({ entries: chosen, data: reviewed }: NonNullable<typeof confirming>) {
    setConfirming(undefined);
    setError(undefined);
    const succeeded = await (publisher ? queuePublish : publishReviewed)(
      chosen,
      reviewed,
      () => mounted.current,
    );
    if (succeeded && mounted.current) clearSelection();
  }

  const markerView = !!current?.markerOnly;
  const position = current
    ? markerView
      ? `${count.format(index - view.contentCount + 1)} / ${count.format(view.markerCount)}`
      : `${count.format(index + 1)} / ${count.format(view.contentCount)}`
    : '';
  const fields = useReviewMarks((state) =>
    current ? state.fields[current.tooltip.hash] : undefined,
  );
  const marks = current ? changeMarks(fields, current) : [];
  const previous = current ? stepRow(view, index, -1) : -1;
  const next = current ? stepRow(view, index, 1) : -1;
  const liveAvailable = Boolean(apiUrl && user?.role);
  const locked = current
    ? pushing || !!current.unpublishable || inFlight.has(current.tooltip.hash)
    : true;

  return (
    <>
      <p role="status" className={opening ? styles.openingStatus : styles.readyStatus}>
        {opening ? 'Loading sidebar…' : 'Review ready.'}
      </p>
      <article ref={article} aria-busy={loading} className={styles.page}>
        <header className={styles.summary}>
          <h1 className={styles.readyStatus}>Review changes</h1>
          <p className={styles.counts}>
            <span className={styles.segment}>
              <b>{count.format(changeCount)}</b> {changeCount === 1 ? 'change' : 'changes'}
            </span>
            {/* Each "·" stays with the segment after it, so a wrapped line never ends in one. */}
            {markerTotal > 0 && (
              <>
                {' '}
                <span className={styles.segment}>
                  {'· '}
                  <Link
                    to={{ search: markerSearch(searchParams) }}
                    replace
                    title="Alias-marker migration leftovers: saved content equals live"
                    onClick={() => openMarkers()}
                  >
                    {count.format(markerTotal)} marker-only
                  </Link>
                </span>
              </>
            )}{' '}
            <span className={styles.segment}>· {hashes.length} selected</span>
            {hashes.length > 0 && (
              <>
                {' '}
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
          </p>
          <span className={styles.summaryEnd}>
            <button type="button" disabled={pushing || loading} onClick={() => void load()}>
              Refresh
            </button>
            {canPush(user) && (
              <button
                type="button"
                className={styles.primary}
                disabled={pushing || loading || !hashes.length}
                onClick={askToPublish}
              >
                {publisher
                  ? pushing
                    ? 'Starting...'
                    : `Publish selected (${hashes.length})`
                  : pushing
                    ? 'Pushing...'
                    : `Push selected (${hashes.length})`}
              </button>
            )}
          </span>
        </header>
        {Object.keys(drafts).length > 0 && (
          <p className={styles.note}>
            Local drafts are not included. Save them through the tooltip editor first.
          </p>
        )}
        {!liveAvailable && (
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
        <SkeletonBoundary
          pending={loading}
          error={!!error}
          label="Comparing publishable content..."
          shape="rows"
        >
          {!entries.length ? (
            <p className={styles.note}>No saved changes are waiting to go live.</p>
          ) : !current && !view.contentCount && view.markerCount ? (
            <p className={styles.note}>
              {changeCount
                ? 'No changes made by a person match these filters.'
                : 'No changes made by a person are waiting to go live.'}{' '}
              <Link
                to={{ search: markerSearch(searchParams) }}
                replace
                onClick={() => openMarkers()}
              >
                Show the {count.format(view.markerCount)} marker-only leftovers
              </Link>
            </p>
          ) : !ordered.length ? (
            <section className={styles.empty}>
              <p>No saved changes match these filters.</p>
              <button
                type="button"
                data-perf-navigation="true"
                onClick={() =>
                  setSearchParams(filterParams(searchParams, entries, '', ''), { replace: true })
                }
              >
                Clear filters
              </button>
            </section>
          ) : (
            current && (
              <>
                <div className={styles.identity}>
                  <span className={styles.identityText}>
                    <span className={styles.muted}>{current.category}</span>
                    <span className={styles.sep} aria-hidden="true">
                      ·
                    </span>
                    <h2 title={current.name}>{current.name}</h2>
                    <span className={`${styles.muted} ${styles.hash}`}>{current.tooltip.hash}</span>
                    {marks.map((mark) => (
                      <small key={mark} className={styles.mark} data-mark={mark}>
                        {mark}
                      </small>
                    ))}
                  </span>
                  {/* Phones: one joined stepper `‹ 1 of 140 ›` right of the name. */}
                  <span className={styles.stepper} role="group" aria-label="Step through changes">
                    <button
                      type="button"
                      className={styles.step}
                      aria-label="Previous change"
                      disabled={previous === index || pushing}
                      data-perf-navigation="true"
                      onClick={() => selectIndex((value) => stepRow(view, value, -1))}
                    >
                      ‹
                    </button>
                    <span className={styles.stepPosition}>{position.replace(' / ', ' of ')}</span>
                    <button
                      type="button"
                      className={styles.step}
                      aria-label="Next change"
                      disabled={next === index || pushing}
                      data-perf-navigation="true"
                      onClick={() => selectIndex((value) => stepRow(view, value, 1))}
                    >
                      ›
                    </button>
                  </span>
                  <span className={styles.identityEnd}>
                    <span className={styles.muted}>{position}</span>
                    <Link to={`/t/${current.tooltip.hash}`}>Open in editor ↗</Link>
                  </span>
                </div>
                {markerView && (
                  <p className={styles.markerNote} role="note">
                    Marker-only: an alias-marker migration leftover. The saved content equals the
                    live version, so this is not a change a person made. A data task clears these;
                    group select never includes them.
                  </p>
                )}
                {current.unpublishable && <p className={styles.note}>{current.unpublishable}</p>}
                {liveAvailable ? (
                  <ReviewDetail
                    key={current.tooltip.hash}
                    entry={current}
                    included={selected.has(current.tooltip.hash)}
                    selectionLocked={locked}
                    onInclude={toggleRow}
                  />
                ) : (
                  <label className={styles.include}>
                    <input
                      type="checkbox"
                      checked={selected.has(current.tooltip.hash)}
                      disabled={locked}
                      onChange={() => toggleRow(current.tooltip.hash)}
                    />{' '}
                    Include in publish <kbd>Space</kbd>
                  </label>
                )}
              </>
            )
          )}
        </SkeletonBoundary>
      </article>
    </>
  );
}

/** The header's marker-only link: the list's filters stay, the open change does not. */
function markerSearch(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.delete('hash');
  next.set('marker', '1');
  return `?${next.toString()}`;
}
