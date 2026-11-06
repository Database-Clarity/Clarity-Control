import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { behindLabel, type QueueRow } from './queue';
import { entryPath } from './worklist';
import styles from './TranslationsPage.module.scss';

const defaultRowHeight = 32;
const overscan = 6;

/** Where each visited queue left off, so Back lands on the same rows. Keyed by history entry. */
const memory = new Map<string, { top: number; selected: string | null }>();

export function stateText(row: QueueRow): string {
  return row.state === 'missing' ? 'Missing' : `Outdated · ${behindLabel(row.ageMs ?? 0)}`;
}

/**
 * Fixed-height rows in a bounded window: a few dozen DOM rows however long the queue. One tab
 * stop; arrows, Home, End and Page keys move the selection, Enter opens it.
 */
export function QueueList({ rows, label }: { rows: readonly QueueRow[]; label: string }) {
  const location = useLocation();
  const saved = memory.get(location.key);
  const host = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  const [selected, setSelected] = useState(() => {
    const index = saved?.selected ? rows.findIndex((row) => row.key === saved.selected) : -1;
    return Math.max(0, index);
  });
  const [rowHeight, setRowHeight] = useState(defaultRowHeight);
  const [viewport, setViewport] = useState(() => ({
    top: saved?.top ?? 0,
    height: Math.max(defaultRowHeight, window.innerHeight - 160),
  }));
  const observed = useRef({ rowHeight, viewport });
  observed.current = { rowHeight, viewport };
  const focusAfterRender = useRef(false);
  const scrolled = useRef(saved?.top ?? 0);

  useLayoutEffect(() => {
    const element = host.current!;
    if (saved?.top) element.scrollTop = saved.top;
    if (typeof ResizeObserver === 'undefined') {
      setViewport((previous) => ({ ...previous, height: element.clientHeight || previous.height }));
      return;
    }
    // Native observation supplies the real window before the first paint, without geometry reads.
    const observer = new ResizeObserver((entries) => {
      let height = observed.current.viewport.height;
      let row = observed.current.rowHeight;
      for (const entry of entries) {
        if (entry.target === sizer.current) row = entry.contentRect.height || defaultRowHeight;
        else height = entry.contentRect.height;
      }
      if (height === observed.current.viewport.height && row === observed.current.rowHeight) return;
      flushSync(() => {
        setRowHeight(row);
        setViewport((previous) =>
          previous.height === height ? previous : { ...previous, height },
        );
      });
    });
    observer.observe(element);
    observer.observe(sizer.current!);
    return () => observer.disconnect();
    // The saved position applies to the first mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the position for this history entry; opening a row unmounts the queue.
  const selectedKey = useRef<string | null>(null);
  selectedKey.current = rows[Math.min(selected, rows.length - 1)]?.key ?? null;
  useLayoutEffect(() => {
    const key = location.key;
    return () => void memory.set(key, { top: scrolled.current, selected: selectedKey.current });
  }, [location.key]);

  const total = rows.length;
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan);
  const indices: number[] = [];
  for (let index = start; index < end; index++) indices.push(index);
  // The selected row keeps its place in the tab order and focus, even when scrolled away.
  const kept = Math.min(selected, total - 1);
  if (kept >= 0 && (kept < start || kept >= end)) indices.push(kept);

  useLayoutEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    host.current
      ?.querySelector<HTMLAnchorElement>(`[data-index="${kept}"] a`)
      ?.focus({ preventScroll: true });
  });

  const move = (next: number) => {
    const target = Math.max(0, Math.min(total - 1, next));
    const top = target * rowHeight;
    const view = { top: scrolled.current, height: observed.current.viewport.height };
    focusAfterRender.current = true;
    if (top < view.top || top + rowHeight > view.top + view.height) {
      const destination = Math.max(
        0,
        Math.min(
          total * rowHeight - view.height,
          top < view.top ? top : top + rowHeight - view.height,
        ),
      );
      flushSync(() => {
        setViewport((previous) => ({ ...previous, top: destination }));
        setSelected(target);
      });
      scrolled.current = destination;
      host.current!.scrollTop = destination;
    } else setSelected(target);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !total) return;
    const page = Math.max(1, Math.floor(viewport.height / rowHeight) - 1);
    const steps: Record<string, number> = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      PageDown: selected + page,
      PageUp: selected - page,
      Home: 0,
      End: total - 1,
    };
    if (!(event.key in steps)) return;
    event.preventDefault();
    move(steps[event.key]!);
  };

  return (
    <div
      ref={host}
      className={styles.viewport}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        scrolled.current = top;
        // Only a change of first row needs a new window; commit it in the scroll turn itself,
        // so a flick never outruns the rows.
        if (Math.floor(top / rowHeight) === Math.floor(observed.current.viewport.top / rowHeight))
          return;
        flushSync(() => setViewport((previous) => ({ ...previous, top })));
      }}
    >
      <span ref={sizer} className={styles.sizer} aria-hidden="true" />
      <ul
        className={styles.list}
        aria-label={label}
        style={{ height: total * rowHeight }}
        onKeyDown={onKeyDown}
      >
        {indices.map((index) => {
          const row = rows[index]!;
          const isSelected = index === kept;
          return (
            <li
              key={row.key}
              className={styles.row}
              data-index={index}
              aria-posinset={index + 1}
              aria-setsize={total}
              style={{ top: index * rowHeight }}
            >
              <Link
                to={entryPath(row)}
                tabIndex={isSelected ? 0 : -1}
                data-selected={isSelected ? '' : undefined}
                data-perf-navigation="true"
                title={`${row.name} · ${row.hash}`}
                onFocus={() => setSelected(index)}
              >
                <span className={styles.name}>{row.name}</span>
                <span className={styles.category}>{row.category}</span>
                <span
                  className={styles.state}
                  data-state={row.state}
                  data-exported={row.exportedInEnglish ? '' : undefined}
                  title={
                    row.exportedInEnglish
                      ? 'More than 90 days behind English, so the exported text is English'
                      : undefined
                  }
                >
                  {stateText(row)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
