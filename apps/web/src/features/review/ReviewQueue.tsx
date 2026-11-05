import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import type { SidebarPendingChange } from '../navigation/sidebarQueue';
import styles from './ReviewQueue.module.scss';
import { requireReviewRows, useReviewOpening } from './opening';

const defaultRowHeight = 64;
const overscan = 1;
const QueueLink = memo(function QueueLink({
  change,
  href,
  current,
}: {
  change: SidebarPendingChange;
  href: string;
  current: boolean;
}) {
  return (
    <a
      href={`${href}?hash=${change.hash}`}
      data-review-hash={change.hash}
      title={`${change.name} · ${change.hash}`}
      aria-current={current ? 'page' : undefined}
    >
      <span>{change.name}</span>
      <small>{change.hash}</small>
    </a>
  );
});

/** Fixed-height, bounded DOM; URL selection also reveals rows outside the current window. */
export function ReviewQueue({
  changes,
  selectedHash,
}: {
  changes: SidebarPendingChange[];
  selectedHash: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  const [rowHeight, setRowHeight] = useState(defaultRowHeight);
  const observedRowHeight = useRef(rowHeight);
  observedRowHeight.current = rowHeight;
  // Resolve the router/base href once per window, rather than querying <base> per row.
  const href = useHref('/review');
  const navigate = useNavigate();
  const location = useLocation();
  const currentHash =
    selectedHash ?? (!location.search && changes[0] ? String(changes[0].hash) : null);
  const [focusIndex, setFocusIndex] = useState<number>();
  const warming = useReviewOpening((state) => state.warming);
  const openingLimit = useReviewOpening((state) => state.limit);
  const openingToken = useReviewOpening((state) => state.token);
  const pendingOpen = useRef<number>();
  const restoringOpen = useRef<number>();
  const pendingReveal = useRef<number>();
  const previousChanges = useRef(changes);
  useLayoutEffect(() => {
    if (previousChanges.current !== changes && warming) useReviewOpening.setState({ limit: 0 });
    previousChanges.current = changes;
  }, [changes, warming]);
  // Start from the CSS viewport's default 37px header + 7rem allowance, avoiding
  // an oversized provisional window at the ordinary scale. Native observation
  // corrects other font sizes and viewport bounds before paint, without reads.
  const [viewport, setViewport] = useState(() => ({
    top: 0,
    height: Math.max(defaultRowHeight, window.innerHeight - 37 - 7 * (defaultRowHeight / 4)),
  }));
  const observedViewport = useRef(viewport);
  observedViewport.current = viewport;
  const wheelFrame = useRef<number>();
  const wheelTarget = useRef(0);
  const cancelWheel = useCallback(() => {
    if (wheelFrame.current !== undefined) cancelAnimationFrame(wheelFrame.current);
    wheelFrame.current = undefined;
  }, []);
  useLayoutEffect(() => {
    const element = host.current!;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || !event.deltaY) return;
      const current = observedViewport.current;
      const top = wheelFrame.current === undefined ? current.top : wheelTarget.current;
      const unit = event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? current.height : 1;
      const next = Math.max(
        0,
        Math.min(changes.length * rowHeight - current.height, top + event.deltaY * unit),
      );
      // Retain ordinary scroll chaining only once this pane is already at its edge.
      if (next === top && wheelFrame.current === undefined) return;
      event.preventDefault();
      wheelTarget.current = next;
      if (wheelFrame.current !== undefined) return;
      wheelFrame.current = requestAnimationFrame(() => {
        wheelFrame.current = undefined;
        const top = wheelTarget.current;
        if (top === observedViewport.current.top) return;
        // Render the destination before moving the native viewport: compositor
        // scrolling must not run ahead of a bounded React window and expose blanks.
        flushSync(() => setViewport((previous) => ({ ...previous, top })));
        element.scrollTop = top;
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel);
      if (wheelFrame.current !== undefined) cancelAnimationFrame(wheelFrame.current);
      wheelFrame.current = undefined;
    };
  }, [changes.length, rowHeight]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'undefined') return;
    // Older browsers without an observer still need exact scaled row bounds.
    const height = host.current!.clientHeight;
    const row = sizer.current!.getBoundingClientRect().height;
    if (height) setViewport((previous) => ({ ...previous, height }));
    if (row) setRowHeight(row);
  }, []);
  useLayoutEffect(() => {
    const element = host.current!;
    if (typeof ResizeObserver === 'undefined') return;
    // Register before the first paint so native layout supplies the initial
    // window, rather than painting the provisional rows and shrinking later.
    const observer = new ResizeObserver((entries) => {
      let height = observedViewport.current.height;
      let measuredRow = observedRowHeight.current;
      for (const entry of entries) {
        if (entry.target === sizer.current)
          measuredRow = entry.contentRect.height || defaultRowHeight;
        else height = entry.contentRect.height;
      }
      // A native observation of the provisional sizes needs no commit. Even a
      // no-op flushSync may drain unrelated pending work before this paint.
      if (height === observedViewport.current.height && measuredRow === observedRowHeight.current)
        return;
      // Native notifications arrive after layout and before paint. Commit the
      // correctly scaled window now without a synchronous geometry read.
      flushSync(() => {
        setRowHeight(measuredRow);
        setViewport((previous) =>
          previous.height === height ? previous : { ...previous, height },
        );
      });
    });
    observer.observe(element);
    observer.observe(sizer.current!);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    cancelWheel();
    const index = changes.findIndex((entry) => String(entry.hash) === selectedHash);
    if (index < 0) return;
    const top = index * rowHeight;
    // ResizeObserver and scroll events already supply these bounds. Reading DOM
    // geometry here flushes the entire newly mounted workspace's layout.
    const viewport = observedViewport.current;
    if (top < viewport.top || top + rowHeight > viewport.top + viewport.height) {
      const destination = Math.max(0, Math.min(changes.length * rowHeight - viewport.height, top));
      if (destination === viewport.top) return;
      pendingReveal.current = destination;
      setViewport((previous) => ({ ...previous, top: destination }));
    }
  }, [cancelWheel, changes, selectedHash, rowHeight, viewport.height]);
  useLayoutEffect(() => {
    if (pendingReveal.current !== viewport.top) return;
    pendingReveal.current = undefined;
    host.current!.scrollTop = viewport.top;
  }, [viewport.top]);
  useEffect(() => {
    if (warming || pendingOpen.current !== undefined) return;
    if (restoringOpen.current !== undefined) {
      if (selectedHash !== String(restoringOpen.current)) return;
      const link = host.current?.querySelector<HTMLAnchorElement>(
        `[data-review-hash="${restoringOpen.current}"]`,
      );
      if (link) {
        restoringOpen.current = undefined;
        link.focus({ preventScroll: true });
      }
      return;
    }
    if (!warming && focusIndex !== undefined)
      host.current
        ?.querySelector<HTMLAnchorElement>(`[data-index="${focusIndex}"] a`)
        ?.focus({ preventScroll: true });
  }, [focusIndex, warming, selectedHash, viewport.top]);
  useEffect(() => {
    if (warming || pendingOpen.current === undefined) return;
    const hash = pendingOpen.current;
    pendingOpen.current = undefined;
    if (changes.some((change) => change.hash === hash)) {
      restoringOpen.current = hash;
      setFocusIndex(undefined);
      void navigate(`/review?hash=${hash}`);
    }
  }, [warming, changes, navigate]);
  const start = Math.max(
    0,
    Math.min(changes.length - 1, Math.floor(viewport.top / rowHeight)) - overscan,
  );
  const end = Math.min(
    changes.length,
    start + Math.ceil(viewport.height / rowHeight) + overscan * 2,
  );
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // A wheel scroll must not unmount the focused anchor and silently move focus to <body>.
  if (focusIndex !== undefined && focusIndex < changes.length && !indices.includes(focusIndex))
    indices.push(focusIndex);
  useLayoutEffect(() => requireReviewRows(indices.length), [indices.length, openingToken]);
  const renderedIndices = warming ? indices.slice(0, openingLimit) : indices;
  return (
    <div
      ref={host}
      className={styles.viewport}
      style={{ height: changes.length * rowHeight }}
      tabIndex={0}
      aria-label="Scroll pending saved changes"
      aria-busy={warming || undefined}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey
        )
          return;
        const link =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('a[data-review-hash]')
            : null;
        if (
          !link ||
          !event.currentTarget.contains(link) ||
          link.hasAttribute('download') ||
          (link.target && link.target !== '_self')
        )
          return;
        event.preventDefault();
        const to = `/review?hash=${link.dataset.reviewHash}`;
        // One router subscription/handler for the queue: memoized rows keep
        // their native anchor behavior without mounting routing hooks per row.
        void navigate(to, {
          replace: `${location.pathname}${location.search}${location.hash}` === to,
        });
      }}
      onPointerDownCapture={cancelWheel}
      onFocusCapture={(event) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-index]');
        if (row) setFocusIndex(Number(row.dataset.index));
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          pendingOpen.current = undefined;
          restoringOpen.current = undefined;
          setFocusIndex(undefined);
        }
      }}
      onKeyDown={(event) => {
        if (warming && event.key === 'Enter' && focusIndex !== undefined) {
          event.preventDefault();
          pendingOpen.current = changes[focusIndex]?.hash;
          return;
        }
        const row = (event.target as Element).closest<HTMLElement>('[data-index]');
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (!row && (event.target !== event.currentTarget || event.key === 'Tab')) return;
        const index = row
          ? Number(row.dataset.index)
          : (focusIndex ??
            Math.max(
              0,
              changes.findIndex((change) => String(change.hash) === currentHash),
            ));
        let next: number;
        if (event.key === 'ArrowDown') next = Math.min(changes.length - 1, index + 1);
        else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
        else if (event.key === 'PageDown')
          next = Math.min(
            changes.length - 1,
            index + Math.max(1, Math.floor(viewport.height / rowHeight)),
          );
        else if (event.key === 'PageUp')
          next = Math.max(0, index - Math.max(1, Math.floor(viewport.height / rowHeight)));
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = changes.length - 1;
        else if (event.key === 'Tab') {
          next = index + (event.shiftKey ? -1 : 1);
          if (next < 0 || next >= changes.length) return;
        } else return;
        cancelWheel();
        event.preventDefault();
        const element = event.currentTarget;
        const top = next * rowHeight;
        if (top < viewport.top || top + rowHeight > viewport.top + viewport.height) {
          const destination = Math.max(
            0,
            Math.min(changes.length * rowHeight - viewport.height, top),
          );
          // Keyboard jumps need the same render-before-scroll ordering as wheels.
          flushSync(() => {
            setViewport((previous) => ({ ...previous, top: destination }));
            setFocusIndex(next);
          });
          element.scrollTop = destination;
        } else setFocusIndex(next);
      }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        // Controlled wheel frames already committed this position. A no-op
        // flushSync can still drain unrelated updates during an input burst.
        if (top === observedViewport.current.top) return;
        // Commit the small window in this scroll turn, before the browser paints
        // its new position. This needs only one buffer row in either direction.
        flushSync(() =>
          setViewport((previous) => (previous.top === top ? previous : { ...previous, top })),
        );
      }}
    >
      <span ref={sizer} className={styles.rowSizer} aria-hidden="true" data-review-row-size="" />
      <div style={{ height: changes.length * rowHeight }} aria-hidden="true" />
      {warming && (
        <div
          className={styles.openingRows}
          aria-hidden="true"
          style={{ top: start * rowHeight, height: (end - start) * rowHeight }}
        >
          {indices
            .filter((index) => index >= start && index < end)
            .map((index) => (
              <div
                key={index}
                className={styles.openingRow}
                style={{ top: (index - start) * rowHeight, height: rowHeight }}
              >
                <span />
                <span />
              </div>
            ))}
        </div>
      )}
      <ul
        className={styles.list}
        aria-hidden={warming || undefined}
        style={{
          top: start * rowHeight,
          height: (end - start) * rowHeight,
          visibility: warming ? 'hidden' : undefined,
        }}
      >
        {renderedIndices.map((index) => {
          const change = changes[index]!;
          return (
            <li
              key={change.hash}
              aria-posinset={index + 1}
              aria-setsize={changes.length}
              data-index={index}
              style={{ top: (index - start) * rowHeight, height: rowHeight }}
            >
              <QueueLink
                change={change}
                href={href}
                current={currentHash === String(change.hash)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
