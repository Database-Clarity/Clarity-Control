import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { publisherEnabled } from '../../services/publisher/flag';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { useAdvanceSetting } from '../compendium/advanceSetting';
import { useRawDiff } from '../history/diffPreference';
import { useLeftQueue } from '../queue/useQueue';
import {
  editorLabel,
  editorPath,
  publishedOf,
  routedRow,
  rowKey,
  unitCount,
  unitName,
  unresolvedRow,
  useReviewRows,
  type RowKey,
} from './globalRows';
import { classifyRows, kindOf, useKinds, useRowKinds } from './kinds';
import {
  canPush,
  pendingTooltips,
  preparedPending,
  publishSelection,
  publishSidebar,
  type PendingTooltip,
} from './model';
import { loadPublished, publishedFor, publishedRows, usePublished } from './published';
import { PublishActivity } from './PublishActivity';
import { planReviewedPublish, queuePublish } from './publishAction';
import { publishDriver } from './publisher';
import { PushConfirm } from './PushConfirm';
import { queueView, stepRow } from './queueModel';
import { useReviewQueue } from './queueStore';
import { ReviewDetail, RestoreLive } from './ReviewDetail';
import { filterParams, SelectionCounts, useInFlight } from './ReviewSidebar';
import { acknowledgedMarkers, publishReviewed, useReviewSession } from './session';
import {
  BatchesHeader,
  BatchesMain,
  SubviewSwitch,
  canReadBatches,
  preloadBatches,
  reviewSubview,
} from './subview';
import styles from './Review.module.scss';

const count = new Intl.NumberFormat('en');
const noEntries: PendingTooltip[] = [];

/** The phone bar's "…" menu; it closes on Escape (focus back on "…"), a press outside, or use. */
function More({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      if (!menu.current?.open) return;
      menu.current.open = false;
      if (refocus) menu.current.querySelector('summary')?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    };
    const pointerdown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close(false);
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', pointerdown, true);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', pointerdown, true);
    };
  }, [open]);
  return (
    <details
      ref={menu}
      className={styles.more}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="More actions">…</summary>
      <div className={styles.moreMenu}>{children}</div>
    </details>
  );
}

interface Decision {
  hash: number;
  /** The row it was made on. */
  key: RowKey;
  /** The tick before the decision. */
  was: boolean;
}

export function ReviewPage() {
  useLeftQueue();
  const phone = useMedia(phoneQuery);
  const article = useRef<HTMLElement>(null);
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
  const reloading = useDataStore((state) => state.refreshing);
  const load = useDataStore((state) => state.load);
  const user = useAuthStore((state) => state.user);
  // Saved | Batches (scheduled changes; build switch OFF or no batch role: always Saved).
  const subview = reviewSubview(searchParams, user);
  const batchesView = useRef(subview === 'batches');
  batchesView.current = subview === 'batches';
  useEffect(() => preloadBatches(user), [user]);
  const drafts = useDraftStore((state) => Object.keys(state.drafts).length);
  const { pushing, notice, error: pushError, acknowledgments } = useReviewSession();
  const prepared = useMemo(
    () => (data && !Object.keys(acknowledgments).length ? preparedPending(data) : undefined),
    [data, acknowledgments],
  );
  const [entries, setEntries] = useState<PendingTooltip[] | undefined>(prepared);
  const selected = useReviewQueue((state) => state.selected);
  const setIncluded = useReviewQueue((state) => state.setIncluded);
  const clearSelection = useReviewQueue((state) => state.clearSelection);
  const collapsed = useReviewQueue((state) => state.collapsed);
  const leftovers = useReviewQueue((state) => state.leftovers);
  // What the confirm dialog lists is exactly what gets pushed, from the snapshot it was opened on.
  const [confirming, setConfirming] = useState<{
    entries: PendingTooltip[];
    data: EditorData;
    inputs?: ReturnType<typeof planReviewedPublish>;
  }>();
  // A newer snapshot is being compared; the old list and open change stay on screen meanwhile.
  const [comparing, setComparing] = useState(!prepared);
  const query = searchParams.get('query') ?? '';
  const kindFilter = searchParams.get('kind') ?? '';
  const publisher = publisherEnabled();
  const inFlight = useInFlight();
  const liveAvailable = Boolean(apiUrl && user?.role);
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
  // The bar's status line, for the change it is about; gone once the ticks are reset.
  const [message, setMessage] = useState<{ text: string; hash: number; included?: boolean }>();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  useEffect(() => {
    let active = true;
    if (!data) return;
    // The initial snapshot was already checked against these exact saved markers.
    if (prepared) {
      setEntries(prepared);
      setComparing(false);
      clearSelection();
      setDecisions([]);
      setMessage(undefined);
      return;
    }
    const markers = acknowledgedMarkers(data);
    const ready = preparedPending(data, markers);
    if (ready) {
      setEntries(ready);
      setComparing(false);
      clearSelection();
      setDecisions([]);
      setMessage(undefined);
      return;
    }
    setComparing(true);
    void pendingTooltips(data, markers).then(
      (result) => {
        if (!active) return;
        setEntries(result);
        // The list kept showing the previous snapshot while this one was compared: nothing picked
        // there may carry over to saved text nobody has looked at.
        clearSelection();
        setDecisions([]);
        setMessage(undefined);
        setComparing(false);
      },
      (reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setComparing(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [data, acknowledgments, prepared, clearSelection]);
  const list = entries ?? noEntries;
  // What the list shows; what is ticked and published is always an entry of `list`.
  const rows = useReviewRows(entries ?? null);
  // The published text of every waiting change, once, in the background; then the row words.
  const published = usePublished((state) => state.byHash);
  const classified = useKinds((state) => state.byHash);
  useEffect(() => {
    // A new snapshot (Refresh) also asks again for rows whose last request failed.
    if (entries && liveAvailable) void loadPublished(publishedRows(entries), true);
  }, [entries, liveAvailable, user]);
  useEffect(() => {
    if (!entries || !data) return;
    classifyRows(
      rows.map((entry) => ({ entry, published: publishedOf(entry, published) })),
      data,
    );
  }, [entries, rows, published, data]);
  const kinds = useRowKinds(rows);
  const view = useMemo(
    () => queueView(rows, query, kindFilter, collapsed, leftovers, kinds),
    [rows, query, kindFilter, collapsed, leftovers, kinds],
  );
  const { ordered } = view;
  const changeCount = useMemo(() => list.filter(({ markerOnly }) => !markerOnly).length, [list]);
  const routedHash = searchParams.get('hash');
  const routed = routedHash === null ? undefined : routedRow(ordered, routedHash);
  const routedIndex = routed ? ordered.indexOf(routed) : -1;
  // Without a route, open the first change; leftovers open only when named or picked.
  const index = routedIndex >= 0 ? routedIndex : view.contentCount ? 0 : -1;
  const current = index < 0 ? undefined : ordered[index];
  const selectRow = useCallback(
    (key: RowKey | undefined) => {
      if (key === undefined) return;
      const intent = selectionIntent.current;
      const params = new URLSearchParams(intent?.params ?? searchParams);
      if (params.get('hash') === String(key)) return;
      params.set('hash', String(key));
      const targets = intent?.targets ?? new Set<string>();
      targets.add(params.toString());
      selectionIntent.current = { params, targets };
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  const selectIndex = useCallback(
    (step: (current: number) => number) => {
      if (!ordered.length) return;
      const intent = selectionIntent.current;
      const pendingIndex = intent
        ? ordered.findIndex((row) => String(rowKey(row)) === intent.params.get('hash'))
        : -1;
      const row = ordered[step(pendingIndex < 0 ? index : pendingIndex)];
      selectRow(row && rowKey(row));
    },
    [index, ordered, selectRow],
  );
  useEffect(() => {
    if (entries) publishSidebar(entries);
  }, [entries]);
  // A named row the filters may still show (its word is being checked), or that the published
  // file may still list: its link is kept until that is known.
  const waitingRow = useMemo(() => {
    if (routedHash === null) return false;
    const row = rows.find((candidate) => String(rowKey(candidate)) === routedHash);
    if (!row) return unresolvedRow(rows, routedHash, published);
    if (!row.part || !kindFilter || kinds.get(rowKey(row))) return false;
    const status = publishedOf(row, published)?.status;
    return status !== 'error' && status !== 'missing';
  }, [routedHash, rows, published, kindFilter, kinds]);
  useEffect(() => {
    if (subview === 'batches' || !entries || selectionIntent.current || waitingRow) return;
    const params = new URLSearchParams(searchParams);
    if (!current) {
      if (!params.has('hash')) return;
      params.delete('hash');
      setSearchParams(params, { replace: true });
      return;
    }
    if (searchParams.get('hash') === String(rowKey(current))) return;
    params.set('hash', String(rowKey(current)));
    setSearchParams(params, { replace: true });
  }, [current, entries, searchParams, setSearchParams, subview, waitingRow]);
  useEffect(() => {
    clearSelection();
    setDecisions([]);
    setMessage(undefined);
  }, [user, clearSelection]);
  // Review's own readiness mark (the shared perf harness): the first frame after the page painted.
  useEffect(() => {
    if (!entries || !window.requestAnimationFrame) return;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (article.current?.isConnected && location.hash.startsWith('#/review'))
          performance.mark?.('review:interactive', { detail: { route: location.hash } });
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [entries === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(
    () => publishSelection(selected, list, inFlight),
    [selected, list, inFlight],
  );
  useEffect(() => {
    // Manual inclusion can select migration leftovers skipped by the background comparisons.
    if (publisher && liveAvailable)
      void loadPublished(
        chosen.flatMap(({ markerOnly, tooltip, pushed }) =>
          markerOnly ? [{ hash: tooltip.hash, marker: pushed }] : [],
        ),
        true,
      );
  }, [chosen, liveAvailable, publisher]);
  const included = current ? selected.has(current.tooltip.hash) : false;
  const locked = current
    ? pushing || !canPush(user) || !!current.unpublishable || inFlight.has(current.tooltip.hash)
    : true;

  // ---- Include / Skip / Undo, with the Compendium's auto-advance pause ----
  const advanceMs = useAdvanceSetting((state) => state.ms);
  const [pause, setPause] = useState<{ next?: PendingTooltip; token: number; verb: string }>();
  const pauseTimer = useRef<number>();
  const stopPause = useCallback(() => {
    if (pauseTimer.current !== undefined) window.clearTimeout(pauseTimer.current);
    pauseTimer.current = undefined;
    setPause(undefined);
  }, []);
  useEffect(() => stopPause, [stopPause]);
  // A decision covers every row of its change, so it moves past all of them.
  const nextEntry = (decided = false) => {
    if (!current) return undefined;
    for (let at = index; ;) {
      const next = stepRow(view, at, 1);
      if (next === at) return undefined;
      if (!decided || ordered[next]!.tooltip.hash !== current.tooltip.hash) return ordered[next];
      at = next;
    }
  };
  const advance = (verb: string) => {
    const next = nextEntry(true);
    if (!next) return;
    if (advanceMs === 0) return selectRow(rowKey(next));
    stopPause();
    setPause({ next, token: Date.now(), verb });
    pauseTimer.current = window.setTimeout(() => {
      pauseTimer.current = undefined;
      setPause(undefined);
      selectRow(rowKey(next));
    }, advanceMs);
  };
  const decide = () => {
    if (!current || locked || pause) return;
    const hash = current.tooltip.hash;
    setDecisions((stack) => [...stack.slice(-49), { hash, key: rowKey(current), was: included }]);
    setIncluded(hash, !included);
    setMessage({
      text: `${unitName(current)}: ${included ? 'removed from' : 'included in'} the publish.`,
      hash,
      included: !included,
    });
    advance(included ? 'Removed' : 'Included');
  };
  const skip = () => {
    if (!current || pause) return;
    const next = nextEntry();
    if (next) selectRow(rowKey(next));
  };
  const undo = () => {
    const last = decisions.at(-1);
    if (!last || pushing) return;
    stopPause();
    setDecisions((stack) => stack.slice(0, -1));
    setIncluded(last.hash, last.was);
    const entry = rows.find(({ tooltip }) => tooltip.hash === last.hash);
    setMessage({
      text: entry ? `${unitName(entry)}: undone.` : 'Last decision undone.',
      hash: last.hash,
    });
    if (ordered.some((row) => rowKey(row) === last.key)) selectRow(last.key);
  };
  // Another open change (a row click, the URL, Back) or new filters end a pause without moving
  // again. The pause's own move clears it before it navigates, so it never cancels itself.
  const currentKey = current && rowKey(current);
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  useEffect(() => {
    if (pauseRef.current) stopPause();
  }, [currentKey, query, kindFilter, stopPause]);

  function askToPublish() {
    // Only a role that can publish, and never while a reload may replace the reviewed snapshot.
    if (!canPush(user) || !data || !entries || comparing || reloading || pushing) return;
    if (!chosen.length) return;
    setError(undefined);
    try {
      const inputs = publisher ? planReviewedPublish(chosen, entries, data) : undefined;
      setConfirming({ entries: chosen, data, inputs });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  // A confirmation belongs to the snapshot it listed: new saved data retires it, out loud.
  useEffect(() => {
    if (!confirming || confirming.data === data) return;
    setConfirming(undefined);
    setError(
      'The list changed while the publish was being confirmed. Review it and publish again.',
    );
  }, [confirming, data]);
  const [raw, setRaw] = useRawDiff();
  const actions = useRef({ decide, skip, undo, askToPublish, selectIndex, raw, setRaw, pause });
  actions.current = { decide, skip, undo, askToPublish, selectIndex, raw, setRaw, pause };
  const committedView = useRef(view);
  useLayoutEffect(() => {
    committedView.current = view;
  }, [view]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || workspaceShortcutsBlocked(event)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || pushing) return;
      // The Saved list's keys never act on it while Batches is shown.
      if (batchesView.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const control = !!target?.closest(
        'button, a, summary, [aria-label="Scroll pending saved changes"]',
      );
      const key = event.key;
      const lower = key.toLowerCase();
      const run = actions.current;
      if (key === '/') {
        const find = document.querySelector<HTMLInputElement>('[data-review-find]');
        if (find) {
          event.preventDefault();
          find.focus();
        }
        return;
      }
      if (key === 'Escape') {
        if (run.pause) {
          event.preventDefault();
          stopPause();
        }
        return;
      }
      if (run.pause && (key === 'Enter' || key === 'ArrowDown')) {
        // Move now, once, to the change the bar announced.
        event.preventDefault();
        const next = run.pause.next;
        stopPause();
        if (next) selectRow(rowKey(next));
        return;
      }
      if (lower === 'u') {
        event.preventDefault();
        run.undo();
        return;
      }
      if (lower === 'r') {
        event.preventDefault();
        run.setRaw(!run.raw);
        return;
      }
      if (lower === 'p') {
        event.preventDefault();
        run.askToPublish();
        return;
      }
      if (lower === 's') {
        event.preventDefault();
        run.skip();
        return;
      }
      // Enter, Space, and arrows belong to a focused control or the list.
      if (control) return;
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        run.decide();
        return;
      }
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
      event.preventDefault();
      if (run.pause) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      run.selectIndex((value) => stepRow(committedView.current, value, delta));
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [pushing, selectRow, stopPause]);

  async function publish({
    entries: picked,
    data: reviewed,
    inputs,
  }: NonNullable<typeof confirming>) {
    setConfirming(undefined);
    setError(undefined);
    const isMounted = () => mounted.current;
    const succeeded = inputs
      ? await queuePublish(inputs, reviewed, isMounted)
      : await publishReviewed(picked, reviewed, isMounted);
    if (succeeded && mounted.current) {
      clearSelection();
      setDecisions([]);
      setMessage(undefined);
    }
  }

  const leftoverView = !!current?.markerOnly;
  // Positions count changes, like every other number: the rows of one globals file share one.
  const position = useMemo(() => {
    if (index < 0) return '';
    const from = index < view.contentCount ? 0 : view.contentCount;
    const all = ordered.slice(from, from ? undefined : view.contentCount);
    const at = unitCount(all.slice(0, index - from + 1));
    return `${count.format(at)} / ${count.format(unitCount(all))}`;
  }, [index, ordered, view.contentCount]);
  const previous = current ? stepRow(view, index, -1) : -1;
  const next = current ? stepRow(view, index, 1) : -1;
  const currentPublished = current && publishedOf(current, published);
  const classification = current ? kindOf(current, currentPublished, classified) : undefined;
  const retry = useCallback(() => {
    if (current) void loadPublished([{ hash: current.tooltip.hash, marker: current.pushed }], true);
  }, [current]);
  const refreshing = reloading || comparing;

  const switcher =
    SubviewSwitch && canReadBatches(user) ? (
      <Suspense fallback={null}>
        <SubviewSwitch />
      </Suspense>
    ) : null;
  if (subview === 'batches' && BatchesMain && BatchesHeader)
    return (
      <article className={styles.page} data-subview="batches">
        <header className={styles.summary}>
          <h1 className={styles.readyStatus}>Review changes: batches</h1>
          {switcher}
          <Suspense fallback={null}>
            <BatchesHeader />
          </Suspense>
        </header>
        <Suspense fallback={<p className={styles.note}>Loading batches…</p>}>
          <BatchesMain phone={phone} />
        </Suspense>
      </article>
    );

  const restore = current && (
    <RestoreLive
      entry={current.part?.unit ?? current}
      name={unitName(current)}
      published={publishedFor(published, current.tooltip.hash, current.pushed)}
      onDone={(text) => setMessage({ text, hash: current.tooltip.hash })}
    />
  );
  return (
    <article ref={article} aria-busy={!entries} className={styles.page}>
      <header className={styles.summary}>
        <h1 className={styles.readyStatus}>Review changes</h1>
        {switcher}
        <p className={styles.counts}>
          {entries ? (
            <SelectionCounts changes={changeCount} />
          ) : (
            'Checking what is waiting to go live…'
          )}
        </p>
        <span className={styles.summaryEnd}>
          <button
            type="button"
            disabled={pushing || refreshing}
            onClick={() => void load({ background: true })}
          >
            {refreshing && entries ? 'Refreshing…' : 'Refresh'}
          </button>
          {canPush(user) && (
            <button
              type="button"
              className={styles.primary}
              data-review-publish
              disabled={pushing || refreshing || !chosen.length}
              onClick={askToPublish}
            >
              {pushing
                ? publisher
                  ? 'Starting…'
                  : 'Publishing…'
                : chosen.length
                  ? `Publish ${count.format(chosen.length)}`
                  : 'Publish'}
              <kbd>P</kbd>
            </button>
          )}
        </span>
      </header>
      {!canPush(user) && (
        <p className={styles.notice} role="note">
          {apiUrl
            ? 'Sign in as an editor or maintainer to publish.'
            : 'Publishing needs a configured API. Saved changes remain local.'}
        </p>
      )}
      {confirming && (
        <PushConfirm
          entries={confirming.entries}
          rows={rows}
          kinds={kinds}
          background={publisher}
          onConfirm={() => void publish(confirming)}
          onCancel={() => setConfirming(undefined)}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {pushError && <p role="alert">{pushError}</p>}
      {notice && <p role="status">{notice}</p>}
      {publisher && canPush(user) && <PublishActivity queue={data?.bundle.publishQueue} />}
      {!entries ? null : !changeCount && !current ? (
        <section className={styles.empty}>
          <p>
            <b>Nothing is waiting to go live.</b> Changes appear here once they are saved in the
            editor.
          </p>
          {drafts > 0 && (
            <p>
              {count.format(drafts)} {drafts === 1 ? 'draft' : 'drafts'} on this device{' '}
              {drafts === 1 ? 'is' : 'are'} not saved yet.{' '}
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
        </section>
      ) : !current ? (
        <section className={styles.empty}>
          <p>No change matches.</p>
          <button
            type="button"
            data-perf-navigation="true"
            onClick={() =>
              setSearchParams(filterParams(searchParams, rows, kinds, '', ''), { replace: true })
            }
          >
            Clear filters
          </button>
        </section>
      ) : (
        <>
          <div className={styles.identity}>
            {phone && (
              <button
                type="button"
                className={styles.step}
                aria-label="Previous change"
                disabled={previous === index}
                data-perf-navigation="true"
                onClick={() => selectIndex((value) => stepRow(view, value, -1))}
              >
                ‹
              </button>
            )}
            <span className={styles.identityText}>
              <span className={`${styles.muted} ${styles.category}`}>{current.category}</span>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              <h2 title={current.name}>{current.name}</h2>
              <span className={`${styles.muted} ${styles.hash}`}>{current.tooltip.hash}</span>
            </span>
            <span className={styles.identityEnd}>
              {included && <span className={styles.included}>Included</span>}
              <span className={styles.muted}>
                {leftoverView ? `${position} leftovers` : position}
              </span>
              <Link to={editorPath(current)}>{editorLabel(current)} ↗</Link>
            </span>
            {phone && (
              <button
                type="button"
                className={styles.step}
                aria-label="Next change"
                disabled={next === index}
                data-perf-navigation="true"
                onClick={() => selectIndex((value) => stepRow(view, value, 1))}
              >
                ›
              </button>
            )}
          </div>
          <div className={styles.detailHead}>
            <ReviewDetail
              key={rowKey(current)}
              entry={current}
              published={currentPublished}
              classification={classification}
              raw={raw}
              onRetry={retry}
            />
            {!phone && (
              <button
                type="button"
                className={styles.rawToggle}
                aria-pressed={raw}
                onClick={() => setRaw(!raw)}
              >
                Raw markup <kbd>R</kbd>
              </button>
            )}
          </div>
          <footer className={styles.bar} aria-label="Decide">
            {pause && (
              <span
                key={pause.token}
                className={styles.advanceLine}
                style={{ animationDuration: `${advanceMs}ms` }}
                aria-hidden="true"
              />
            )}
            {canPush(user) && (
              <button
                type="button"
                className={styles.include}
                disabled={locked || !!pause}
                title={current.unpublishable}
                onClick={decide}
              >
                {included ? 'Remove' : 'Include'} <kbd>⏎</kbd>
              </button>
            )}
            <button type="button" disabled={!!pause || next === index} onClick={skip}>
              Skip <kbd>S</kbd>
            </button>
            {phone ? (
              <>
                <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                  Raw
                </button>
                <More>
                  {canPush(user) && (
                    <button type="button" disabled={!decisions.length || pushing} onClick={undo}>
                      Undo
                    </button>
                  )}
                  {restore}
                </More>
              </>
            ) : (
              canPush(user) && (
                <button type="button" disabled={!decisions.length || pushing} onClick={undo}>
                  Undo <kbd>U</kbd>
                </button>
              )
            )}
            <span className="sr-only" role="status">
              {message?.text}
            </span>
            {/* The phone bar keeps its four buttons; the pause shows as the line above them. */}
            {!phone && (
              <span className={styles.barEnd}>
                {pause ? (
                  <span className={styles.next}>
                    {pause.verb}. Next: <strong>{pause.next?.name}</strong> · Esc to stay
                  </span>
                ) : (
                  message?.hash === current.tooltip.hash &&
                  (message.included === undefined || message.included === included) && (
                    <span className={styles.next}>{message.text}</span>
                  )
                )}
                {restore}
              </span>
            )}
          </footer>
        </>
      )}
    </article>
  );
}
