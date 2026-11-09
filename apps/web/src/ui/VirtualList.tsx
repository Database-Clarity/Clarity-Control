import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import styles from './VirtualList.module.scss';

const overscan = 1;

/** First index whose bottom edge is below `top` (offsets[i] is the top of item i; last entry is the total). */
function indexAt(offsets: Float64Array, top: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid + 1] <= top) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low);
}

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Item height in rem, so the list follows the interface scale. */
  heightRem(item: T): number;
  itemKey(item: T): string | number;
  renderItem(item: T, index: number): ReactNode;
  /** Index to keep visible; scrolls only when it is outside the viewport. */
  reveal?: number;
  /** The item that stays pinned at the top while its group is in view (a group header). */
  stickyFor?(item: T, index: number): ReactNode;
  /** Index of the header whose group contains `index`, or -1. */
  groupStart?(index: number): number;
  role?: string;
  label: string;
  activeDescendant?: string;
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  busy?: boolean;
}

/**
 * Fixed-height-per-kind virtual list: a flat item model (rows and group headers), a bounded DOM
 * window, and render-before-scroll so native scrolling never outruns the rendered rows.
 */
export function VirtualList<T>({
  items,
  heightRem,
  itemKey,
  renderItem,
  reveal,
  stickyFor,
  groupStart,
  role = 'list',
  label,
  activeDescendant,
  className,
  onKeyDown,
  busy,
}: VirtualListProps<T>) {
  const host = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  const [unit, setUnit] = useState(16);
  const [viewport, setViewport] = useState({ top: 0, height: 640 });
  const latest = useRef({ unit, viewport });
  latest.current = { unit, viewport };
  // The native scroll position, which can be ahead of the committed window.
  const scrollTop = useRef(0);
  const offsets = useMemo(() => {
    const result = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) result[i + 1] = result[i] + heightRem(items[i]) * unit;
    return result;
  }, [items, heightRem, unit]);
  const total = offsets[items.length];
  const totalRef = useRef(total);
  totalRef.current = total;

  useLayoutEffect(() => {
    const element = host.current!;
    const rem = sizer.current!;
    const measure = () => {
      const nextUnit = rem.getBoundingClientRect().height || 16;
      const height = element.clientHeight || latest.current.viewport.height;
      if (nextUnit !== latest.current.unit || height !== latest.current.viewport.height)
        flushSync(() => {
          setUnit(nextUnit);
          setViewport((previous) =>
            previous.height === height ? previous : { ...previous, height },
          );
        });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(rem);
    return () => observer.disconnect();
  }, []);

  const moveTo = useCallback((top: number) => {
    const element = host.current!;
    scrollTop.current = top;
    flushSync(() => setViewport((previous) => (previous.top === top ? previous : { ...previous, top })));
    element.scrollTop = top;
  }, []);

  // Keep the revealed item in view: render the destination first, then move the native scroll.
  useLayoutEffect(() => {
    if (reveal === undefined || reveal < 0 || reveal >= items.length) return;
    const view = { ...latest.current.viewport, top: scrollTop.current };
    const top = offsets[reveal];
    const bottom = offsets[reveal + 1];
    if (top >= view.top && bottom <= view.top + view.height) return;
    // Show the group's header with the row when it fits, so the position reads in context.
    const header = groupStart?.(reveal) ?? -1;
    const context = header >= 0 && bottom - offsets[header] <= view.height ? offsets[header] : top;
    const destination =
      top < view.top
        ? context
        : Math.max(0, Math.min(totalRef.current - view.height, bottom - view.height));
    moveTo(Math.max(0, Math.min(Math.max(0, totalRef.current - view.height), destination)));
  }, [reveal, offsets, items.length, groupStart, moveTo]);

  const first = Math.max(0, indexAt(offsets, viewport.top) - overscan);
  let last = first;
  while (last < items.length && offsets[last] < viewport.top + viewport.height) last++;
  last = Math.min(items.length, last + overscan);
  const indices: number[] = [];
  for (let i = first; i < last; i++) indices.push(i);
  const stickyIndex = stickyFor && groupStart ? groupStart(indexAt(offsets, viewport.top)) : -1;

  return (
    <div
      ref={host}
      className={`${styles.viewport} ${className ?? ''}`}
      role={role}
      aria-label={label}
      aria-activedescendant={activeDescendant}
      aria-busy={busy || undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        const previous = scrollTop.current;
        scrollTop.current = top;
        // The window and the pinned group depend only on the first visible item.
        if (indexAt(offsets, top) === indexAt(offsets, previous)) return;
        flushSync(() => setViewport((view) => ({ ...view, top })));
      }}
    >
      <span ref={sizer} className={styles.sizer} aria-hidden="true" />
      {stickyFor && stickyIndex >= 0 && stickyIndex < items.length && (
        <div className={styles.sticky}>
          <div style={{ height: heightRem(items[stickyIndex]) * unit }}>
            {stickyFor(items[stickyIndex], stickyIndex)}
          </div>
        </div>
      )}
      <div className={styles.track} style={{ height: total }} aria-hidden="true" />
      <div className={styles.window} style={{ top: offsets[first], height: offsets[last] - offsets[first] }}>
        {indices.map((index) => {
          const item = items[index];
          return (
            <div
              key={itemKey(item)}
              className={styles.item}
              style={{ top: offsets[index] - offsets[first], height: heightRem(item) * unit }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
