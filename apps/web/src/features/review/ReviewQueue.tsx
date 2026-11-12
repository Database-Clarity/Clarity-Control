import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import { flushSync } from 'react-dom';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import styles from './ReviewQueue.module.scss';
import { requireReviewRows, useReviewOpening } from './opening';
import { changeMarks } from './changedFields';
import { useReviewMarks } from './reviewMarks';
import { markerGroup, type QueueGroup, type QueueItem, type QueueView } from './queueModel';
import { useReviewQueue } from './queueStore';
import type { PendingTooltip } from './model';

const countFormat = new Intl.NumberFormat('en');

const defaultRowHeight = 32;
const defaultHeaderHeight = 24;
const overscan = 1;

const QueueRow = memo(function QueueRow({
  entry,
  href,
  current,
  checked,
  locked,
  publishing,
}: {
  entry: PendingTooltip;
  href: string;
  current: boolean;
  checked: boolean;
  /** Part of a publish that is still queued or being sent. */
  publishing: boolean;
  /** Not selectable: unpublishable, or a publish is under way. */
  locked: string | undefined;
}) {
  const fields = useReviewMarks((state) => state.fields[entry.tooltip.hash]);
  const marks = changeMarks(fields, entry);
  const hash = entry.tooltip.hash;
  return (
    <div className={styles.row} data-current={current || undefined}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          readOnly
          disabled={!!locked}
          title={locked}
          data-review-toggle={hash}
          aria-label={`Select ${entry.name}, ${entry.category}, ${hash}`}
        />
      </label>
      <a
        href={`${href}?hash=${hash}`}
        data-review-hash={hash}
        title={`${entry.name} · ${hash}${entry.unpublishable ? ` · ${entry.unpublishable}` : ''}`}
        aria-label={`${entry.name} ${hash}`}
        aria-current={current ? 'page' : undefined}
      >
        <span>{entry.name}</span>
        {(marks.length > 0 || publishing) && (
          <span className={styles.marks}>
            {publishing && <small data-mark="Publishing">publishing…</small>}
            {marks.map((mark) => (
              <small key={mark} data-mark={mark}>
                {mark}
              </small>
            ))}
          </span>
        )}
      </a>
    </div>
  );
});

const GroupHeader = memo(function GroupHeader({
  group,
  selectedCount,
  available,
  locked,
}: {
  group: QueueGroup;
  /** How many of the group's selectable rows (publishable, not in flight) are selected. */
  selectedCount: number;
  /** The group's selectable rows: publishable and not part of a publish under way. */
  available: number;
  locked: boolean;
}) {
  const marker = group.id === markerGroup;
  const checkbox = useRef<HTMLInputElement>(null);
  const all = available > 0 && selectedCount === available;
  useLayoutEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = selectedCount > 0 && selectedCount < available;
  }, [selectedCount, available]);
  return (
    <div className={styles.group} data-marker={marker || undefined}>
      {!marker && (
        <label className={styles.check}>
          <input
            ref={checkbox}
            type="checkbox"
            checked={all}
            readOnly
            disabled={locked}
            data-review-group-toggle={group.id}
            aria-label={`Select all ${group.count} in ${group.label}`}
          />
        </label>
      )}
      <button
        type="button"
        data-review-group={group.id}
        aria-expanded={!group.collapsed}
        title={
          marker
            ? 'Alias-marker migration leftovers: saved content equals live. A data task clears these.'
            : undefined
        }
      >
        <span className={styles.chevron} aria-hidden="true" />
        <span className={styles.groupName}>{group.label}</span>
        <span className={styles.groupCount}>{countFormat.format(group.count)}</span>
      </button>
    </div>
  );
});

let rememberedHash: string | null = null;

/**
 * The left-column queue: category groups with counts, a checkbox per row (the publish
 * selection), and one collapsed marker-only group. Fixed heights per kind, a bounded DOM window,
 * render-before-scroll, and URL selection reveals rows outside the current window.
 */
export function ReviewQueue({
  view,
  selectedHash,
  locked = false,
  inFlight,
}: {
  view: QueueView;
  selectedHash: string | null;
  /** A publish is starting: selection is frozen. */
  locked?: boolean;
  inFlight?: ReadonlySet<number>;
}) {
  const items = view.items;
  const placeholderPattern = useId();
  const host = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  const headerSizer = useRef<HTMLSpanElement>(null);
  const [rowHeight, setRowHeight] = useState(defaultRowHeight);
  const [headerHeight, setHeaderHeight] = useState(defaultHeaderHeight);
  const observed = useRef({ rowHeight, headerHeight });
  observed.current = { rowHeight, headerHeight };
  const offsets = useMemo(() => {
    const result = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++)
      result[i + 1] = result[i]! + (items[i]!.kind === 'group' ? headerHeight : rowHeight);
    return result;
  }, [items, rowHeight, headerHeight]);
  const total = offsets[items.length]!;
  const indexAt = useCallback(
    (top: number) => {
      let low = 0;
      let high = Math.max(0, items.length - 1);
      while (low < high) {
        const mid = (low + high) >> 1;
        if (offsets[mid + 1]! <= top) low = mid + 1;
        else high = mid;
      }
      return low;
    },
    [items.length, offsets],
  );
  // Resolve the router/base href once per window, rather than querying <base> per row.
  const href = useHref('/review');
  const navigate = useNavigate();
  const location = useLocation();
  const firstRow = items.find((item) => item.kind === 'row');
  const currentHash =
    selectedHash ??
    (!location.search && firstRow?.kind === 'row' ? String(firstRow.entry.tooltip.hash) : null);
  const selected = useReviewQueue((state) => state.selected);
  const toggle = useReviewQueue((state) => state.toggle);
  const toggleAll = useReviewQueue((state) => state.toggleAll);
  const toggleGroup = useReviewQueue((state) => state.toggleGroup);
  // On a phone the list is the header's sheet: opening a change closes it over the detail.
  const closeSheet = useContext(FinderSheetCloseContext);
  const [focusIndex, setFocusIndex] = useState<number>();
  const warming = useReviewOpening((state) => state.warming);
  const openingLimit = useReviewOpening((state) => state.limit);
  const openingToken = useReviewOpening((state) => state.token);
  const pendingOpen = useRef<number>();
  const restoringOpen = useRef<number>();
  const pendingReveal = useRef<number>();
  const previousItems = useRef(items);
  useLayoutEffect(() => {
    if (previousItems.current !== items && warming) useReviewOpening.setState({ limit: 0 });
    previousItems.current = items;
  }, [items, warming]);
  // Start from the CSS viewport's default 37px header + filter row allowance, avoiding an
  // oversized provisional window at the ordinary scale. Native observation corrects other font
  // sizes and viewport bounds before paint, without reads. Returning to the same selection
  // restores the list's last scroll position.
  const [viewport, setViewport] = useState(() => ({
    top: rememberedHash !== null && rememberedHash === selectedHash ? useReviewQueue.getState().scrollTop : 0,
    height: Math.max(defaultRowHeight, window.innerHeight - 37 - 7 * (defaultRowHeight / 2)),
  }));
  const observedViewport = useRef(viewport);
  observedViewport.current = viewport;
  const restoredTop = useRef(viewport.top);
  useLayoutEffect(() => {
    if (restoredTop.current) host.current!.scrollTop = restoredTop.current;
  }, []);
  useEffect(() => {
    rememberedHash = currentHash;
  }, [currentHash]);
  useEffect(
    () => () => {
      useReviewQueue.setState({ scrollTop: observedViewport.current.top });
    },
    [],
  );
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
      const next = Math.max(0, Math.min(total - current.height, top + event.deltaY * unit));
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
  }, [total, rowHeight]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'undefined') return;
    // Older browsers without an observer still need exact scaled row bounds.
    const height = host.current!.clientHeight;
    const row = sizer.current!.getBoundingClientRect().height;
    const header = headerSizer.current!.getBoundingClientRect().height;
    if (height) setViewport((previous) => ({ ...previous, height }));
    if (row) setRowHeight(row);
    if (header) setHeaderHeight(header);
  }, []);
  useLayoutEffect(() => {
    const element = host.current!;
    if (typeof ResizeObserver === 'undefined') return;
    // Register before the first paint so native layout supplies the initial
    // window, rather than painting the provisional rows and shrinking later.
    const observer = new ResizeObserver((entries) => {
      let height = observedViewport.current.height;
      let { rowHeight: row, headerHeight: header } = observed.current;
      for (const entry of entries) {
        if (entry.target === sizer.current) row = entry.contentRect.height || defaultRowHeight;
        else if (entry.target === headerSizer.current)
          header = entry.contentRect.height || defaultHeaderHeight;
        else height = entry.contentRect.height;
      }
      // A native observation of the provisional sizes needs no commit. Even a
      // no-op flushSync may drain unrelated pending work before this paint.
      if (
        height === observedViewport.current.height &&
        row === observed.current.rowHeight &&
        header === observed.current.headerHeight
      )
        return;
      // Native notifications arrive after layout and before paint. Commit the
      // correctly scaled window now without a synchronous geometry read.
      flushSync(() => {
        setRowHeight(row);
        setHeaderHeight(header);
        setViewport((previous) =>
          previous.height === height ? previous : { ...previous, height },
        );
      });
    });
    observer.observe(element);
    observer.observe(sizer.current!);
    observer.observe(headerSizer.current!);
    return () => observer.disconnect();
  }, []);
  const selectedIndex = useMemo(
    () =>
      selectedHash === null
        ? -1
        : items.findIndex(
            (item) => item.kind === 'row' && String(item.entry.tooltip.hash) === selectedHash,
          ),
    [items, selectedHash],
  );
  useLayoutEffect(() => {
    cancelWheel();
    if (selectedIndex < 0) return;
    const top = offsets[selectedIndex]!;
    const bottom = offsets[selectedIndex + 1]!;
    // ResizeObserver and scroll events already supply these bounds. Reading DOM
    // geometry here flushes the entire newly mounted workspace's layout.
    const viewport = observedViewport.current;
    if (top < viewport.top || bottom > viewport.top + viewport.height) {
      // Show the group's header with the row when the row is its first, so it reads in context.
      const context = items[selectedIndex - 1]?.kind === 'group' ? offsets[selectedIndex - 1]! : top;
      const destination = Math.max(
        0,
        Math.min(total - viewport.height, top < viewport.top ? context : bottom - viewport.height),
      );
      if (destination === viewport.top) return;
      pendingReveal.current = destination;
      setViewport((previous) => ({ ...previous, top: destination }));
    }
  }, [cancelWheel, items, offsets, selectedIndex, total, viewport.height]);
  // A shorter list (a filter, a collapsed group) can leave the window past its end. A reveal of
  // the selected row in this same commit already chose an in-range destination: it wins.
  useLayoutEffect(() => {
    if (pendingReveal.current !== undefined) return;
    const max = Math.max(0, total - observedViewport.current.height);
    if (observedViewport.current.top <= max) return;
    pendingReveal.current = max;
    setViewport((previous) => ({ ...previous, top: max }));
  }, [total]);
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
        ?.querySelector<HTMLElement>(
          `[data-index="${focusIndex}"] a, [data-index="${focusIndex}"] button`,
        )
        ?.focus({ preventScroll: true });
  }, [focusIndex, warming, selectedHash, viewport.top]);
  useEffect(() => {
    if (warming || pendingOpen.current === undefined) return;
    const hash = pendingOpen.current;
    pendingOpen.current = undefined;
    if (items.some((item) => item.kind === 'row' && item.entry.tooltip.hash === hash)) {
      restoringOpen.current = hash;
      setFocusIndex(undefined);
      void navigate(`/review${hashSearch(location.search, hash)}`);
    }
  }, [warming, items, navigate, location.search]);
  const start = Math.max(0, Math.min(items.length - 1, indexAt(viewport.top)) - overscan);
  let end = start;
  while (end < items.length && offsets[end]! < viewport.top + viewport.height) end++;
  end = Math.min(items.length, end + overscan);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // A wheel scroll must not unmount the focused control and silently move focus to <body>.
  if (focusIndex !== undefined && focusIndex < items.length && !indices.includes(focusIndex))
    indices.push(focusIndex);
  useLayoutEffect(() => requireReviewRows(indices.length), [indices.length, openingToken]);
  const renderedIndices = warming ? indices.slice(0, openingLimit) : indices;
  const pageRows = Math.max(1, Math.floor(viewport.height / rowHeight));

  function open(hash: string) {
    const to = `/review${hashSearch(location.search, hash)}`;
    // One router subscription/handler for the queue: memoized rows keep their native anchor
    // behavior without mounting routing hooks per row.
    void navigate(to, {
      replace: `${location.pathname}${location.search}${location.hash}` === to,
    });
    closeSheet?.();
  }

  return (
    <div
      ref={host}
      className={styles.viewport}
      style={{ height: total }}
      tabIndex={0}
      aria-label="Scroll pending saved changes"
      aria-busy={warming || undefined}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        const checkbox = target?.closest<HTMLInputElement>('input[data-review-toggle]');
        if (checkbox) {
          toggle(Number(checkbox.dataset.reviewToggle));
          return;
        }
        const groupBox = target?.closest<HTMLInputElement>('input[data-review-group-toggle]');
        if (groupBox) {
          const group = items.find(
            (item): item is QueueGroup =>
              item.kind === 'group' && item.id === groupBox.dataset.reviewGroupToggle,
          );
          if (group) toggleAll(group.publishable.filter((hash) => !inFlight?.has(hash)));
          return;
        }
        const header = target?.closest<HTMLButtonElement>('button[data-review-group]');
        if (header) {
          toggleGroup(header.dataset.reviewGroup!);
          return;
        }
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey
        )
          return;
        const link = target?.closest<HTMLAnchorElement>('a[data-review-hash]');
        if (
          !link ||
          !event.currentTarget.contains(link) ||
          link.hasAttribute('download') ||
          (link.target && link.target !== '_self')
        )
          return;
        event.preventDefault();
        open(link.dataset.reviewHash!);
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
        const focusedItem = focusIndex === undefined ? undefined : items[focusIndex];
        if (warming && event.key === 'Enter' && focusedItem?.kind === 'row') {
          event.preventDefault();
          pendingOpen.current = focusedItem.entry.tooltip.hash;
          return;
        }
        const row = (event.target as Element).closest<HTMLElement>('[data-index]');
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (!row && (event.target !== event.currentTarget || event.key === 'Tab')) return;
        const index = row
          ? Number(row.dataset.index)
          : (focusIndex ?? Math.max(0, selectedIndex));
        const item = items[index];
        if (event.key === ' ' && item?.kind === 'row' && event.target instanceof HTMLAnchorElement) {
          // Space on a row includes it in the publish, as on the page.
          event.preventDefault();
          if (!locked && !item.entry.unpublishable && !inFlight?.has(item.entry.tooltip.hash))
            toggle(item.entry.tooltip.hash);
          return;
        }
        let next: number;
        if (event.key === 'ArrowDown') next = Math.min(items.length - 1, index + 1);
        else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
        else if (event.key === 'PageDown') next = Math.min(items.length - 1, index + pageRows);
        else if (event.key === 'PageUp') next = Math.max(0, index - pageRows);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'Tab') {
          // Tab walks the rows' names (Space on a name selects it); Shift+Tab reaches a row's
          // checkbox natively, then the previous row. Rows outside the window stay reachable.
          const onCheckbox = event.target instanceof HTMLInputElement;
          if (event.shiftKey ? !onCheckbox : onCheckbox) return;
          next = index + (event.shiftKey ? -1 : 1);
          if (next < 0 || next >= items.length) return;
        } else return;
        cancelWheel();
        event.preventDefault();
        const element = event.currentTarget;
        const top = offsets[next]!;
        const bottom = offsets[next + 1]!;
        if (top < viewport.top || bottom > viewport.top + viewport.height) {
          const destination = Math.max(
            0,
            Math.min(total - viewport.height, top < viewport.top ? top : bottom - viewport.height),
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
      <span ref={headerSizer} className={styles.headerSizer} aria-hidden="true" />
      <div style={{ height: total }} aria-hidden="true" />
      {warming && (
        <div
          className={styles.openingRows}
          aria-hidden="true"
          style={{ top: offsets[start], height: offsets[end]! - offsets[start]! }}
        >
          <svg width="100%" height="100%" focusable="false">
            <defs>
              <pattern
                id={placeholderPattern}
                width="100%"
                height={rowHeight}
                patternUnits="userSpaceOnUse"
              >
                <rect x="1.75rem" y="0.65rem" width="60%" height="0.7rem" rx="0.15rem" />
                <rect x="85%" y="0.7rem" width="12%" height="0.6rem" rx="0.15rem" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${placeholderPattern})`} />
          </svg>
        </div>
      )}
      <ul
        className={styles.list}
        aria-hidden={warming || undefined}
        style={{
          top: offsets[start],
          height: offsets[end]! - offsets[start]!,
          visibility: warming ? 'hidden' : undefined,
        }}
      >
        {renderedIndices.map((index) => (
          <li
            key={itemKey(items[index]!)}
            aria-posinset={index + 1}
            aria-setsize={items.length}
            data-index={index}
            data-kind={items[index]!.kind}
            style={{
              top: offsets[index]! - offsets[start]!,
              height: offsets[index + 1]! - offsets[index]!,
            }}
          >
            {renderItem(items[index]!)}
          </li>
        ))}
      </ul>
    </div>
  );

  function renderItem(item: QueueItem) {
    if (item.kind === 'group') {
      // Count against the rows the checkbox acts on: in-flight rows are neither picked nor shown
      // as part of the group's state.
      let selectedCount = 0;
      let available = 0;
      for (const hash of item.publishable) {
        if (inFlight?.has(hash)) continue;
        available++;
        if (selected.has(hash)) selectedCount++;
      }
      return (
        <GroupHeader
          group={item}
          selectedCount={selectedCount}
          available={available}
          locked={locked || !available}
        />
      );
    }
    const hash = item.entry.tooltip.hash;
    return (
      <QueueRow
        entry={item.entry}
        href={href}
        current={currentHash === String(hash)}
        checked={selected.has(hash)}
        publishing={!!inFlight?.has(hash)}
        locked={
          item.entry.unpublishable ??
          (inFlight?.has(hash) ? 'Publishing…' : locked ? 'A publish is starting' : undefined)
        }
      />
    );
  }
}

function itemKey(item: QueueItem) {
  return item.kind === 'group' ? `g:${item.id}` : item.entry.tooltip.hash;
}

/** The list's search with only the open hash changed; filters stay. */
export function hashSearch(search: string, hash: string | number) {
  const params = new URLSearchParams(search);
  params.delete('marker');
  params.set('hash', String(hash));
  return `?${params.toString()}`;
}
