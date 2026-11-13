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

/**
 * Puts the list's scroll position back after Leave, once its rows are in place (`ready`). `scroll`
 * is the returned position (undefined on an ordinary visit: nothing happens).
 */
export function useRestoredScroll(
  anchor: React.RefObject<Element | null>,
  scroll: number | undefined,
  ready: boolean,
) {
  const done = useRef(false);
  const frame = useRef(0);
  useLayoutEffect(() => {
    if (done.current || !ready || scroll === undefined || !anchor.current) return;
    done.current = true;
    const element = anchor.current;
    const apply = () => {
      const scroller = scrollerOf(element);
      scroller.scrollTop = scroll;
      return Math.abs(scroller.scrollTop - scroll) <= 1;
    };
    // The shell may still be settling the page's height (a lazy page's first frames): try again
    // for a few frames until the position holds.
    if (apply()) return;
    let frames = 0;
    frame.current = requestAnimationFrame(function retry() {
      if (!apply() && ++frames < 20) frame.current = requestAnimationFrame(retry);
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
}: {
  source: QueueSourceId;
  /** The selected rows the list shows, in its order. */
  selected: QueueItem[];
  /** Every row the list shows, in its order. */
  shown: QueueItem[];
  /** The list's own state to come back to (its scroll is read here). */
  restore: Record<string, unknown>;
  /** Clear selection beside the start button; left out where the list has its own Clear. */
  onClear?(): void;
  /** An element inside the list, to find the list's scroller. */
  anchor: React.RefObject<Element | null>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const context = useSourceContext();
  const disabled = !context;
  function begin(scope: WorkQueue['scope'], items: QueueItem[]) {
    if (!context || !items.length) return;
    const done = queueSources[source].done(context);
    const drafts = useDraftStore.getState().drafts;
    const first = items.find((item) => !done(item, drafts)) ?? items[0]!;
    const { to, state } = startQueue({
      source,
      scope,
      items,
      first,
      origin: {
        path: `${location.pathname}${location.search}`,
        restore: { ...restore, scroll: scrollerOf(anchor.current).scrollTop },
      },
    });
    navigate(to, { state });
  }
  return (
    <div className={styles.bar} role="group" aria-label="Work through">
      {selected.length > 0 && (
        <>
          <button
            type="button"
            disabled={disabled}
            title="Open the selected rows one after another, with Previous and Next (Alt+Page Up, Alt+Page Down)"
            onClick={() => begin('selected', selected)}
          >
            Work through {selected.length} selected
          </button>
          {onClear && (
            <button type="button" className={styles.quiet} onClick={onClear}>
              Clear selection
            </button>
          )}
        </>
      )}
      <button
        type="button"
        disabled={disabled || !shown.length}
        title="Open every row shown, one after another, with Previous and Next (Alt+Page Up, Alt+Page Down)"
        onClick={() => begin('shown', shown)}
      >
        Work through all {shown.length} shown
      </button>
    </div>
  );
}
