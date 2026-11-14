import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDraftStore } from '../../stores/drafts';
import type { QueueItem, QueueSourceId, WorkQueue } from './model';
import { startQueue } from './start';
import { queueSources } from './sources';
import { useSourceContext } from './useQueue';
import styles from './WorkThroughBar.module.scss';

/** The list state a page gets back on Leave, from the history entry's state (or undefined). */
export function returnedState<T>(state: unknown): T | undefined {
  return (state as { workThroughReturn?: T } | null)?.workThroughReturn;
}

/** The nearest element that scrolls `element` (the page's own scroller when nothing nearer does). */
export function scrollerOf(element: Element | null): Element {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
      return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** The first row in view: its key (`data-row-key`) and how far its top sits below the scroller's. */
export interface TopRow {
  key: string;
  offset: number;
}

const viewTop = (scroller: Element) =>
  scroller === document.scrollingElement || scroller === document.documentElement
    ? 0
    : scroller.getBoundingClientRect().top;

/** The first row (`[data-row-key]`) whose bottom is below the scroller's top, if rows carry keys. */
function topRowOf(scroller: Element): TopRow | undefined {
  const top = viewTop(scroller);
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-row-key]')) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top) return { key: row.dataset.rowKey!, offset: box.top - top };
  }
  return undefined;
}

/**
 * Puts the list's scroll position back after Leave, once its rows are in place (`ready`). `scroll`
 * is the returned position (undefined on an ordinary visit: nothing happens). With `top`, the row
 * that was first in view is put back at its place instead: exact even where rows out of view are
 * not rendered (their height is an estimate).
 */
export function useRestoredScroll(
  anchor: React.RefObject<Element | null>,
  scroll: number | undefined,
  ready: boolean,
  top?: TopRow,
  /** The position once it holds, for a page that remembers its own scroll per history entry. */
  onRestored?: (scrollTop: number) => void,
) {
  const done = useRef(false);
  const frame = useRef(0);
  useLayoutEffect(() => {
    if (done.current || !ready || scroll === undefined || !anchor.current) return;
    done.current = true;
    const element = anchor.current;
    const apply = () => {
      const scroller = scrollerOf(element);
      const row = top && scroller.querySelector(`[data-row-key="${CSS.escape(top.key)}"]`);
      if (row) {
        const delta = row.getBoundingClientRect().top - viewTop(scroller) - top.offset;
        scroller.scrollTop += delta;
        return Math.abs(delta) <= 1;
      }
      scroller.scrollTop = scroll;
      return Math.abs(scroller.scrollTop - scroll) <= 1;
    };
    // The shell may still be settling the page's height (a lazy page's first frames), and rows
    // coming into view replace their estimated height: try again for a few frames until it holds.
    const settled = () => onRestored?.(scrollerOf(element).scrollTop);
    // A page can mount before the workspace shows it (no layout yet): wait for its first layout
    // (up to about three seconds) before counting the attempts.
    const laidOut = () => element.getClientRects().length > 0;
    if (laidOut() && apply()) return settled();
    let frames = 0;
    let waited = 0;
    frame.current = requestAnimationFrame(function retry() {
      if (!laidOut()) {
        if (++waited < 180) frame.current = requestAnimationFrame(retry);
        return;
      }
      if (!apply() && ++frames < 20) frame.current = requestAnimationFrame(retry);
      else settled();
    });
  });
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
}

/**
 * "Work through 3 selected" and "Work through all 40 shown": start a queue of those rows, in the
 * list's order, and open the first one still to do. The list's state (filters, selection, scroll)
 * is kept with the queue for Leave and Rebuild queue.
 */
export function WorkThroughBar({
  source,
  selected,
  shown,
  restore,
  onClear,
  anchor,
  dense = false,
}: {
  source: QueueSourceId;
  /** The selected rows the list shows, in its order. */
  selected: QueueItem[];
  /** Every row the list shows, in its order. */
  shown: QueueItem[];
  /** The list's own state to come back to (its scroll is read here). */
  restore: Record<string, unknown>;
  /** Clear selection after the start buttons; left out where the list has its own Clear. */
  onClear?(): void;
  /** An element inside the list, to find the list's scroller. */
  anchor: React.RefObject<Element | null>;
  /** The app's compact controls (Review's list column); otherwise the list page's own buttons. */
  dense?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const context = useSourceContext();
  const disabled = !context;
  const group = useRef<HTMLDivElement>(null);
  // Back from a queue (Leave): focus returns to the bar the queue started from.
  const returned = useRef(returnedState(location.state) !== undefined);
  useEffect(() => {
    if (!returned.current || disabled) return;
    returned.current = false;
    group.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({
      preventScroll: true,
    });
  }, [disabled]);
  function begin(scope: WorkQueue['scope'], items: QueueItem[]) {
    if (!context || !items.length) return;
    const done = queueSources[source].done(context);
    const drafts = useDraftStore.getState().drafts;
    const first = items.find((item) => !done(item, drafts)) ?? items[0]!;
    const scroller = scrollerOf(anchor.current);
    const { to, state } = startQueue({
      source,
      scope,
      items,
      first,
      origin: {
        path: `${location.pathname}${location.search}`,
        restore: { ...restore, scroll: scroller.scrollTop, top: topRowOf(scroller) },
      },
      focus: true,
    });
    navigate(to, { state });
  }
  // "Work through" once, then the two ways in, then Clear: the buttons say "2 selected" and
  // "All 40 shown", their accessible names say it in full.
  return (
    <div
      ref={group}
      className={`${styles.bar}${dense ? ` ${styles.dense}` : ''}`}
      role="group"
      aria-label="Work through"
    >
      <span className={styles.lead} aria-hidden="true">
        Work through
      </span>
      {selected.length > 0 && (
        <button
          type="button"
          disabled={disabled}
          title="Open the selected rows one after another, with Previous and Next (Alt+Page Up, Alt+Page Down)"
          aria-label={`Work through ${selected.length} selected`}
          onClick={() => begin('selected', selected)}
        >
          {selected.length} selected
        </button>
      )}
      <button
        type="button"
        disabled={disabled || !shown.length}
        title="Open every row shown, one after another, with Previous and Next (Alt+Page Up, Alt+Page Down)"
        aria-label={`Work through all ${shown.length} shown`}
        onClick={() => begin('shown', shown)}
      >
        All {shown.length} shown
      </button>
      {selected.length > 0 && onClear && (
        <button
          type="button"
          className={styles.quiet}
          aria-label="Clear selection"
          onClick={onClear}
        >
          Clear
        </button>
      )}
    </div>
  );
}
