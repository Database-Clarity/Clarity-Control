import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigationType } from 'react-router-dom';
import { behindLabel, type QueueRow } from './queue';

import styles from './TranslationsPage.module.scss';

const defaultRowHeight = 32;
const overscan = 6;

/**
 * Where each filtered view was left, so Back lands on the same rows. Keyed by the view itself, not
 * the history entry: committing the typed filter replaces the entry (new key) just before a row
 * opens. Only a Back or Forward arrival restores it; a fresh visit starts at the top.
 */
const memory = new Map<string, { top: number; selected: string | null }>();
let forced: { signature: string; key: string } | null = null;

/** The filter's Enter opens the first match without the list having selected it. */
export function rememberOpenedFirst(signature: string, key: string) {
  forced = { signature, key };
  memory.set(signature, { top: 0, selected: key });
}

export function stateText(row: QueueRow): string {
  return row.state === 'missing' ? 'Missing' : `Outdated · ${behindLabel(row.ageMs ?? 0)}`;
}

/** What a list row needs: its identity and name (the Current queue and the Upcoming view). */
export interface ListRow {
  key: string;
  hash: number;
  name: string;
}

/** The state cell of a row: its text, a data-state for colour, and an optional explanation. */
export interface RowState {
  text: string;
  state: string;
  title?: string;
  exported?: boolean;
}

/** The Current queue's columns: category, then Missing or Outdated with the gap. */
const queueRowState = (row: QueueRow): RowState => ({
  text: stateText(row),
  state: row.state,
  exported: row.exportedInEnglish,
  title: row.exportedInEnglish
    ? 'More than 90 days behind English, so the exported text is English'
    : undefined,
});

/**
 * Fixed-height rows in a bounded window: a few dozen DOM rows however long the queue. One tab
 * stop; arrows, Home, End and Page keys move the selection, Enter opens it.
 */
export function QueueList<Row extends ListRow = QueueRow>({
  rows,
  linkTo,
  onOpen,
  restored,
  label,
  signature,
  secondary = (row) => (row as unknown as QueueRow).category,
  rowState = (row) => queueRowState(row as unknown as QueueRow),
  title = (row) => `${row.name} · ${row.hash}`,
  extra,
  onVisible,
}: {
  rows: readonly Row[];
  /** Where a row opens the editor, and the queue mode state that goes with it. */
  linkTo(row: Row): { to: string; state: unknown };
  /** A plain click or Enter opens `row` in queue mode: the queue starts here (`top`: the scroll). */
  onOpen?(row: Row, top: number): void;
  /** The second column (default: the category). */
  secondary?(row: Row): string;
  /** The state column (default: the Current queue's Missing / Outdated). */
  rowState?(row: Row): RowState;
  /** The row's tooltip text (default: name and hash). */
  title?(row: Row): string;
  extra?(row: Row): ReactNode;
  onVisible?(rows: readonly Row[]): void;
  /** Leave from that queue: the position and row to come back to. */
  restored?: { top: number; selected: string | null };
  label: string;
  /** What the rows are filtered by: a position is only restored for the same view. */
  signature: string;
}) {
  const arrival = useNavigationType();
  const saved = restored ?? (arrival === 'POP' ? memory.get(signature) : undefined);
  const host = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  const [selected, setSelected] = useState(() => {
    const index = saved?.selected ? rows.findIndex((row) => row.key === saved.selected) : -1;
    return Math.max(0, index);
  });
  const previousRows = useRef(rows);
  if (previousRows.current !== rows) {
    const key = previousRows.current[selected]?.key;
    previousRows.current = rows;
    const next = key ? rows.findIndex((row) => row.key === key) : -1;
    if (next >= 0 && next !== selected) setSelected(next);
  }
  const [rowHeight, setRowHeight] = useState(defaultRowHeight);
  const [viewport, setViewport] = useState(() => ({
    top: saved?.top ?? 0,
    height: Math.max(defaultRowHeight, window.innerHeight - 160),
  }));
  const observed = useRef({ rowHeight, viewport });
  observed.current = { rowHeight, viewport };
  // Coming back from the editor, focus returns to the row that was opened.
  // Leave from the queue (`restored`) always does: its link still holds focus as the list mounts.
  const focusAfterRender = useRef(
    !!saved?.selected && (restored !== undefined || document.activeElement === document.body),
  );
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const scrolled = useRef(saved?.top ?? 0);

  useLayoutEffect(() => {
    // An Enter destination belongs only to the departure that opened the editor.
    // Its saved position has now been read; later clicks and keys must win again.
    forced = null;
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
  const opened = useRef<string | null>(null);
  selectedKey.current = rows[Math.min(selected, rows.length - 1)]?.key ?? null;
  useLayoutEffect(
    () => () =>
      void memory.set(signature, {
        top: forced?.signature === signature ? 0 : scrolled.current,
        selected:
          (forced?.signature === signature ? forced.key : null) ??
          opened.current ??
          selectedKey.current,
      }),
    [signature],
  );

  const total = rows.length;
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan);
  const visibleStart = Math.max(0, Math.floor(viewport.top / rowHeight));
  const visibleEnd = Math.min(total, Math.ceil((viewport.top + viewport.height) / rowHeight));
  useEffect(() => {
    onVisible?.(rows.slice(visibleStart, visibleEnd));
    return () => onVisible?.([]);
  }, [rows, visibleStart, visibleEnd, onVisible]);
  const indices: number[] = [];
  for (let index = start; index < end; index++) indices.push(index);
  // The selected row keeps its place in the tab order and focus, even when scrolled away.
  const kept = Math.min(selected, total - 1);
  if (kept >= 0 && (kept < start || kept >= end)) indices.push(kept);

  useLayoutEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    // The workspace can mount the list before it shows it (a hidden row takes no focus): try each
    // frame (about three seconds at most) until focus holds, unless it went somewhere else.
    let tries = 0;
    const attempt = () => {
      const active = document.activeElement;
      if (tries > 0 && active && active !== document.body) return;
      const row = host.current?.querySelector<HTMLAnchorElement>(`[data-index="${kept}"] a`);
      row?.focus({ preventScroll: true });
      if (row && document.activeElement === row) return;
      if (++tries < 180) focusFrame.current = requestAnimationFrame(attempt);
    };
    attempt();
  });

  const move = (next: number) => {
    const target = Math.max(0, Math.min(total - 1, next));
    const top = target * rowHeight;
    const view = { top: scrolled.current, height: observed.current.viewport.height };
    focusAfterRender.current = true;
    opened.current = null;
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
          const shown = rowState(row);
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
                {...linkTo(row)}
                tabIndex={isSelected ? 0 : -1}
                data-selected={isSelected ? '' : undefined}
                data-perf-navigation="true"
                title={title(row)}
                onFocus={() => setSelected(index)}
                // Safari does not focus a link on click; the opened row is still the one to return to.
                onClick={(event) => {
                  opened.current = row.key;
                  // A new tab or window (a modified click) is an ordinary visit.
                  if (
                    event.button === 0 &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    !event.altKey
                  )
                    onOpen?.(row, scrolled.current);
                }}
              >
                <span className={styles.name}>{row.name}</span>
                <span className={styles.category} title={secondary(row)}>
                  {secondary(row)}
                </span>
                <span
                  className={styles.state}
                  data-state={shown.state}
                  data-exported={shown.exported ? '' : undefined}
                  title={shown.title}
                >
                  {shown.text}
                  {extra?.(row)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
