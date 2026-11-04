import { memo, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useHref, useLinkClickHandler } from 'react-router-dom';
import type { SidebarPendingChange } from '../navigation/sidebarQueue';
import styles from './ReviewQueue.module.scss';

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
  const to = `/review?hash=${change.hash}`;
  const onClick = useLinkClickHandler(to);
  return (
    <a
      href={`${href}?hash=${change.hash}`}
      onClick={onClick}
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
  // Resolve the router/base href once per window, rather than querying <base> per row.
  const href = useHref('/review');
  const [focusIndex, setFocusIndex] = useState<number>();
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const observedViewport = useRef(viewport);
  observedViewport.current = viewport;
  useEffect(() => {
    const element = host.current!;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === sizer.current)
          setRowHeight(entry.contentRect.height || defaultRowHeight);
        else setViewport((previous) => ({ ...previous, height: entry.contentRect.height }));
      }
    });
    observer.observe(element);
    observer.observe(sizer.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const index = changes.findIndex((entry) => String(entry.hash) === selectedHash);
    const element = host.current!;
    if (index < 0) return;
    const top = index * rowHeight;
    // ResizeObserver and scroll events already supply these bounds. Reading DOM
    // geometry here flushes the entire newly mounted workspace's layout.
    const viewport = observedViewport.current;
    if (top < viewport.top || top + rowHeight > viewport.top + viewport.height) {
      element.scrollTop = top;
      setViewport((previous) => ({ ...previous, top }));
    }
  }, [changes, selectedHash, rowHeight, viewport.height]);
  useEffect(() => {
    if (focusIndex !== undefined)
      host.current
        ?.querySelector<HTMLAnchorElement>(`[data-index="${focusIndex}"] a`)
        ?.focus({ preventScroll: true });
  }, [focusIndex]);
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
  return (
    <div
      ref={host}
      className={styles.viewport}
      style={{ height: changes.length * rowHeight }}
      tabIndex={0}
      aria-label="Scroll pending saved changes"
      onFocusCapture={(event) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-index]');
        if (row) setFocusIndex(Number(row.dataset.index));
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusIndex(undefined);
      }}
      onKeyDown={(event) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-index]');
        if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
        const index = Number(row.dataset.index);
        let next: number;
        if (event.key === 'ArrowDown') next = Math.min(changes.length - 1, index + 1);
        else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = changes.length - 1;
        else if (event.key === 'Tab') {
          next = index + (event.shiftKey ? -1 : 1);
          if (next < 0 || next >= changes.length) return;
        } else return;
        event.preventDefault();
        const element = event.currentTarget;
        const top = next * rowHeight;
        if (top < viewport.top || top + rowHeight > viewport.top + viewport.height) {
          element.scrollTop = top;
          setViewport((previous) => ({ ...previous, top }));
        }
        setFocusIndex(next);
      }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        // Commit the small window in this scroll turn, before the browser paints
        // its new position. This needs only one buffer row in either direction.
        flushSync(() => setViewport((previous) => ({ ...previous, top })));
      }}
    >
      <span ref={sizer} className={styles.rowSizer} aria-hidden="true" data-review-row-size="" />
      <ul className={styles.list} style={{ height: changes.length * rowHeight }}>
        {indices.map((index) => {
          const change = changes[index]!;
          return (
            <li
              key={change.hash}
              aria-posinset={index + 1}
              aria-setsize={changes.length}
              data-index={index}
              style={{ top: index * rowHeight, height: rowHeight }}
            >
              <QueueLink
                change={change}
                href={href}
                current={selectedHash === String(change.hash)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
