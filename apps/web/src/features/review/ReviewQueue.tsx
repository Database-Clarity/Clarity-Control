import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import { flushSync } from 'react-dom';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import styles from './ReviewQueue.module.scss';
import { editorLabel, editorPath, rowKey, unitName } from './globalRows';
import type { Kind } from './kinds';
import {
  markerGroup,
  type QueueGroup,
  type QueueItem,
  type QueueView,
  type RowKinds,
} from './queueModel';
import { useReviewQueue } from './queueStore';
import type { PendingTooltip } from './model';

const countFormat = new Intl.NumberFormat('en');

const defaultRowHeight = 32;
const defaultHeaderHeight = 24;
const overscan = 1;

const QueueRow = memo(function QueueRow({
  entry,
  href,
  editorHref,
  current,
  checked,
  locked,
  kind,
  distinguish,
}: {
  entry: PendingTooltip;
  distinguish: boolean;
  href: string;
  editorHref: string;
  current: boolean;
  checked: boolean;
  /** The row's word; "Publishing…" while part of a publish that is still running. */
  kind: Kind | 'Publishing…' | undefined;
  /** Not selectable: unpublishable, or a publish is under way. */
  locked: string | undefined;
}) {
  const hash = entry.tooltip.hash;
  const key = rowKey(entry);
  const path = editorPath(entry);
  const label = editorLabel(entry);
  const together =
    entry.part && entry.part.names.length > 1 ? `Ticked together: ${unitName(entry)}` : undefined;
  return (
    <div className={styles.row} data-current={current || undefined}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          readOnly
          disabled={!!locked}
          title={locked ?? together}
          data-review-toggle={hash}
          aria-label={`Include ${entry.name}, ${entry.category}, ${hash}${together ? `. ${together}` : ''}`}
        />
      </label>
      <a
        href={`${href}?hash=${encodeURIComponent(key)}`}
        data-review-hash={key}
        title={`${entry.name} · ${hash}${entry.unpublishable ? ` · ${entry.unpublishable}` : ''}`}
        aria-label={`${entry.name} ${hash}${kind ? `, ${kind}` : ''}`}
        aria-current={current ? 'page' : undefined}
      >
        <span>
          {entry.name}
          {distinguish && <small className={styles.identity}> · {hash}</small>}
        </span>
        {kind && (
          <small className={styles.kind} data-kind={kind}>
            {kind}
          </small>
        )}
      </a>
      {/* Owner 2026-11-16: every item jumps straight to the editor to fix it up. */}
      <a
        className={styles.edit}
        href={`${editorHref}${path}`}
        data-review-edit={key}
        data-review-path={path}
        title={label}
        aria-label={
          label === 'Open in editor' ? `Open ${entry.name} in editor` : `${label} (${entry.name})`
        }
      >
        <span aria-hidden="true">↗</span>
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
  // Rows ticked one by one: no checkbox for the group.
  const plain = marker || group.global === 'edited';
  const checkbox = useRef<HTMLInputElement>(null);
  const all = available > 0 && selectedCount === available;
  useLayoutEffect(() => {
    if (checkbox.current)
      checkbox.current.indeterminate = selectedCount > 0 && selectedCount < available;
  }, [selectedCount, available]);
  return (
    <div className={styles.group} data-marker={marker || undefined} data-global={group.global}>
      {!plain && (
        <label className={styles.check}>
          <input
            ref={checkbox}
            type="checkbox"
            checked={all}
            readOnly
            disabled={locked}
            data-review-group-toggle={group.id}
            aria-label={`Include all ${group.global ? group.publishable.length : group.count} in ${group.label}`}
          />
        </label>
      )}
      <button
        type="button"
        data-review-group={group.id}
        aria-expanded={!group.collapsed}
        title={
          marker
            ? 'Saved text already matches live; listed only because of the alias migration.'
            : group.global === 'edited'
              ? 'Include all leaves these out: include them one by one, or through their category.'
              : group.global
                ? `${group.label} changed: tooltips that show it`
                : group.note
        }
      >
        <span className={styles.chevron} aria-hidden="true" />
        <span className={styles.groupName}>
          {group.label}
          {group.note && <small className={styles.identity}> · {group.note}</small>}
        </span>
        {group.global !== 'edited' && (
          <span className={styles.groupCount}>
            {countFormat.format(group.count)}
            {group.global && <span>{group.count === 1 ? ' tooltip' : ' tooltips'}</span>}
          </span>
        )}
      </button>
    </div>
  );
});

/** A name within the group that lists it: its hash shows only where the name repeats. */
const nameKey = ({ under, categoryId, name }: PendingTooltip) =>
  `${under?.id ?? categoryId}:${name}`;

let rememberedHash: string | null = null;

/**
 * The left-column queue: category groups with counts, a checkbox per row (the publish
 * selection), the row's word, and an editor link. Fixed heights per kind, a bounded DOM window,
 * render-before-scroll, and URL selection reveals rows outside the current window.
 */
export function ReviewQueue({
  view,
  kinds,
  selectedHash,
  locked = false,
  inFlight,
}: {
  view: QueueView;
  kinds: RowKinds;
  selectedHash: string | null;
  /** A publish is starting: selection is frozen. */
  locked?: boolean;
  inFlight?: ReadonlySet<number>;
}) {
  const items = view.items;
  const repeatedNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of view.ordered) {
      const key = nameKey(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
  }, [view.ordered]);
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
  // Resolve the router/base hrefs once per window, rather than querying <base> per row.
  const href = useHref('/review');
  const editorHref = useHref('/').replace(/\/$/, '');
  const navigate = useNavigate();
  const location = useLocation();
  const firstRow = items.find((item) => item.kind === 'row');
  const currentHash =
    selectedHash ??
    (!location.search && firstRow?.kind === 'row' ? String(rowKey(firstRow.entry)) : null);
  const selected = useReviewQueue((state) => state.selected);
  const toggle = useReviewQueue((state) => state.toggle);
  const toggleAll = useReviewQueue((state) => state.toggleAll);
  const toggleGroup = useReviewQueue((state) => state.toggleGroup);
  // On a phone the list is the header's sheet: opening a change closes it over the detail.
  const closeSheet = useContext(FinderSheetCloseContext);
  const [focusIndex, setFocusIndex] = useState<number>();
  const pendingReveal = useRef<number>();
  // Start from the CSS viewport's default 37px header + filter row allowance, avoiding an
  // oversized provisional window at the ordinary scale. Native observation corrects other font
  // sizes and viewport bounds before paint, without reads. Returning to the same selection
  // restores the list's last scroll position.
  const [viewport, setViewport] = useState(() => ({
    top:
      rememberedHash !== null && rememberedHash === selectedHash
        ? useReviewQueue.getState().scrollTop
        : 0,
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
      const hidden = !observedViewport.current.height;
      flushSync(() => {
        setRowHeight(row);
        setHeaderHeight(header);
        setViewport((previous) =>
          previous.height === height ? previous : { ...previous, height },
        );
      });
      // A closed phone sheet forgets its scroll position; the window kept it.
      if (hidden && height) element.scrollTop = observedViewport.current.top;
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
            (item) => item.kind === 'row' && String(rowKey(item.entry)) === selectedHash,
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
      const context =
        items[selectedIndex - 1]?.kind === 'group' ? offsets[selectedIndex - 1]! : top;
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
    if (focusIndex !== undefined)
      host.current
        ?.querySelector<HTMLElement>(
          `[data-index="${focusIndex}"] a, [data-index="${focusIndex}"] button`,
        )
        ?.focus({ preventScroll: true });
  }, [focusIndex, viewport.top]);
  const start = Math.max(0, Math.min(items.length - 1, indexAt(viewport.top)) - overscan);
  let end = start;
  while (end < items.length && offsets[end]! < viewport.top + viewport.height) end++;
  end = Math.min(items.length, end + overscan);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // A wheel scroll must not unmount the focused control and silently move focus to <body>.
  if (focusIndex !== undefined && focusIndex < items.length && !indices.includes(focusIndex))
    indices.push(focusIndex);
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
        const plain =
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.metaKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.shiftKey;
        const edit = target?.closest<HTMLAnchorElement>('a[data-review-edit]');
        if (edit) {
          // Modified clicks keep the native link (a new tab or window).
          if (!plain) return;
          event.preventDefault();
          void navigate(edit.dataset.reviewPath!);
          closeSheet?.();
          return;
        }
        if (!plain) return;
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
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusIndex(undefined);
      }}
      onKeyDown={(event) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-index]');
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (!row && (event.target !== event.currentTarget || event.key === 'Tab')) return;
        const index = row ? Number(row.dataset.index) : (focusIndex ?? Math.max(0, selectedIndex));
        const item = items[index];
        if (
          event.key === ' ' &&
          item?.kind === 'row' &&
          event.target instanceof HTMLAnchorElement
        ) {
          // Space on a row ticks it without moving.
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
          // Tab walks a row's name, then its editor link, then the next row; Shift+Tab reaches a
          // row's checkbox natively, then the previous row. Rows outside the window stay reachable.
          const target = event.target as Element;
          const onCheckbox = target instanceof HTMLInputElement;
          const last =
            target.matches('a[data-review-edit]') || target.matches('button[data-review-group]');
          if (event.shiftKey ? !onCheckbox : !last) return;
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
      <ul
        className={styles.list}
        style={{ top: offsets[start], height: offsets[end]! - offsets[start]! }}
      >
        {indices.map((index) => (
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
    const publishing = !!inFlight?.has(hash);
    return (
      <QueueRow
        entry={item.entry}
        distinguish={repeatedNames.has(nameKey(item.entry))}
        href={href}
        editorHref={editorHref}
        current={currentHash === String(rowKey(item.entry))}
        checked={selected.has(hash)}
        kind={publishing ? 'Publishing…' : kinds.get(rowKey(item.entry))}
        locked={
          item.entry.unpublishable ??
          (publishing ? 'Publishing…' : locked ? 'A publish is starting' : undefined)
        }
      />
    );
  }
}

function itemKey(item: QueueItem) {
  return item.kind === 'group' ? `g:${item.id}` : rowKey(item.entry);
}

/** The list's search with only the open hash changed; filters stay. */
export function hashSearch(search: string, hash: string | number) {
  const params = new URLSearchParams(search);
  params.set('hash', String(hash));
  return `?${params.toString()}`;
}
