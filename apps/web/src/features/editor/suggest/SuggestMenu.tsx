import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { parseMarkup, type Lang, type MarkupGlobals } from '@clarity/core';
import { MarkupSnippet } from '../../preview/TooltipPreview';
import { acceptSuggestion, closeSuggest, moveSuggest, type SuggestSnapshot } from './state';
import type { SuggestContext, SuggestItem } from './source';
import { phoneQuery, useMedia } from '../../../ui/useMedia';
import { dockedBarHeight, dockedTopChrome } from '../markupRow/dock';
import type { UsageCorpus } from './usage';
import styles from './SuggestMenu.module.scss';

/** Keeps the preview from ever breaking the menu: markup the parser rejects shows no preview. */
function parses(text: string, globals: MarkupGlobals): boolean {
  try {
    parseMarkup(text, globals);
    return true;
  } catch {
    return false;
  }
}

interface Placement {
  left: number;
  top: number;
  maxHeight: number;
  /** The menu sits over the caret line's top edge instead of under it. */
  above: boolean;
}

const edge = 8;
const gap = 4;
/** The tallest the menu is ever placed. */
const tallest = 340;

function place(view: EditorView, context: SuggestContext, width: number): Placement | null {
  const anchor = view.coordsAtPos(context.kind === 'selection' ? context.to : context.from);
  // The visible area, which the on-screen keyboard shortens (the layout viewport does not).
  const viewport = window.visualViewport;
  // The docked markup bar (a phone) covers the bottom of that area: the menu stays above it.
  const bottomEdge =
    (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - dockedBarHeight();
  const scroller = view.scrollDOM.getBoundingClientRect();
  // The caret line has scrolled out of the editor: the menu goes with it instead of floating on.
  if (!anchor || anchor.bottom <= scroller.top || anchor.top >= scroller.bottom) return null;
  const below = bottomEdge - anchor.bottom - gap - edge;
  // With the bar docked (a phone), the sticky header and pane tabs cover the top: stay below them.
  const above = anchor.top - gap - Math.max(edge, dockedTopChrome() + gap);
  const useBelow = below >= 240 || below >= above;
  const space = Math.max(120, Math.min(useBelow ? below : above, tallest));
  return {
    left: Math.min(Math.max(edge, anchor.left), Math.max(edge, window.innerWidth - width - edge)),
    // Above the line the menu hangs from this edge (translateY(-100%) in the stylesheet).
    top: useBelow ? anchor.bottom + gap : anchor.top - gap,
    maxHeight: space,
    above: !useBelow,
  };
}

/**
 * One line of the list. Every line is one of two heights (an option, or a heading), so a line's
 * place is two counts: the options and the headings above it. The stylesheet turns the counts
 * into a position, and only the lines on screen are drawn.
 */
interface Row {
  kind: 'heading' | 'divider' | 'option';
  text: string;
  /** Which part of the list starts here, said before the category. */
  part?: string;
  /** The option's index in the snapshot. */
  index: number;
  options: number;
  headings: number;
}

function listRows(items: readonly SuggestItem[]): { rows: Row[]; rowOf: number[] } {
  const rows: Row[] = [];
  const rowOf: number[] = [];
  let options = 0;
  let headings = 0;
  const heading = (kind: 'heading' | 'divider', text: string, part?: string) => {
    rows.push({ kind, text, part, index: -1, options, headings });
    headings += 1;
  };
  for (const [index, item] of items.entries()) {
    const before = items[index - 1];
    // The options this spot calls for sit above a divider; everything else follows it.
    const leavesPinned = before?.pinned && !item.pinned;
    // Each part is named on its first heading, so the two never stack as two lines.
    if (leavesPinned) heading('divider', item.category, 'Other options');
    else if (!before && item.pinned) heading('heading', item.category, 'Fits here');
    else if (!before || before.category !== item.category) heading('heading', item.category);
    rowOf.push(rows.length);
    rows.push({ kind: 'option', text: item.label, index, options, headings });
    options += 1;
  }
  return { rows, rowOf };
}

/** The two line heights in pixels; `all` where there is no layout to window against: draw every line. */
type Metrics = { option: number; heading: number } | 'all';
/** What the last menu measured, so the next one draws the right lines the first time. */
let lastMetrics: Metrics | null = null;
const overscan = 4;

/**
 * The line heights before any menu has been measured, worked out from the stylesheet's own sizes
 * (1.5rem options, var(--tap) on a phone or touch screen; 1.25rem headings) so that opening
 * never has to ask the layout. Every menu checks them against the real lines once it has painted.
 */
function expectedMetrics(): Metrics {
  if (typeof window.matchMedia !== 'function' || typeof ResizeObserver !== 'function') return 'all';
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const touch = window.matchMedia(`${phoneQuery}, (pointer: coarse)`).matches;
  // The touch size: 2.25rem, or max(44px, 2.75rem) with Large (data-touch on the root).
  const large = document.documentElement.dataset.touch === 'large';
  const option = large ? Math.max(44, 2.75 * rem) : 2.25 * rem;
  return { option: touch ? option : 1.5 * rem, heading: 1.25 * rem };
}

const rowTop = (row: Row, metrics: { option: number; heading: number }) =>
  row.options * metrics.option + row.headings * metrics.heading;

export function SuggestMenu({
  snapshot,
  view,
  globals,
  lang,
  usage,
}: {
  snapshot: SuggestSnapshot;
  view: EditorView;
  globals: MarkupGlobals;
  lang: Lang;
  usage?: UsageCorpus;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(() => lastMetrics ?? expectedMetrics());
  const phone = useMedia(phoneQuery);
  // A phone with the keyboard open can leave room for only a few lines: the detail shrinks to
  // its Close button at the side, and the options get the rest.
  const short =
    phone && placement !== null && metrics !== 'all' && placement.maxHeight < metrics.option * 5;
  /** The lines drawn once the list has scrolled; until then it is the top of the list. */
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  /** Where the list is scrolled to and how tall it is, kept here so nothing has to ask the layout. */
  const scrolled = useRef(0);
  const viewHeight = useRef(0);
  /** The pointer chose the option: it is under the pointer already, so the list must not move. */
  const byPointer = useRef(false);
  /** How many lines the unscrolled list draws: what fits the tallest the menu ever is. */
  const [topLines] = useState(() =>
    metrics === 'all'
      ? 0
      : Math.ceil(tallest / Math.min(metrics.option, metrics.heading)) + overscan,
  );
  const { rows, rowOf } = useMemo(() => listRows(snapshot.items), [snapshot.items]);
  const selected = snapshot.items[snapshot.index];
  const { context } = snapshot;
  const itemCount = snapshot.items.length;

  useLayoutEffect(() => {
    const measure = () => {
      const width = surface.current?.offsetWidth ?? 544;
      setPlacement(place(view, context, width));
    };
    measure();
    const scroller = view.scrollDOM;
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [view, context, itemCount]);

  /** Draws the lines a list scrolled to `top` shows. */
  const show = useCallback(
    (top: number) => {
      if (metrics === 'all' || !viewHeight.current) return;
      const bottom = top + viewHeight.current;
      let start = rows.findIndex((row) => rowTop(row, metrics) + metrics.option > top);
      if (start < 0) start = Math.max(0, rows.length - 1);
      let end = rows.findIndex((row, at) => at >= start && rowTop(row, metrics) >= bottom);
      if (end < 0) end = rows.length;
      start = Math.max(0, start - overscan);
      end = Math.min(rows.length, end + overscan);
      setRange((now) => (now && now.start === start && now.end === end ? now : { start, end }));
    },
    [rows, metrics],
  );

  const shown = placement !== null;
  // The real line heights (they follow the UI scale and the touch layout, and may be fractions
  // of a pixel) and the list's height. Asking for them makes the browser lay the menu out, so
  // they are asked for only after the menu has painted, when the answer is already there.
  useEffect(() => {
    const node = list.current;
    if (!node || metrics === 'all') return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        const height = (selector: string) => {
          const found = node.querySelector<HTMLElement>(selector);
          return found?.offsetHeight ? found.getBoundingClientRect().height : 0;
        };
        const option = height('[role=option]');
        // Scrolled deep into one category no heading is drawn: its known height stands.
        const heading = height('[data-suggest-heading]') || metrics.heading;
        const next: Metrics =
          option === metrics.option && heading === metrics.heading
            ? metrics
            : option
              ? { option, heading }
              : 'all';
        // A phone stacks the list over the detail in a short space: the list ends on a whole line
        // instead of showing half of the next one. Measured here, after the menu has painted.
        if (next !== 'all' && window.matchMedia?.(phoneQuery).matches) {
          node.style.maxHeight = '';
          const natural = node.clientHeight;
          let fit = 0;
          for (const row of rows) {
            const end =
              rowTop(row, next) +
              (row.kind === 'option' ? next.option : next.heading) -
              scrolled.current;
            if (end > natural + 0.5) break;
            if (end > 0 && row.kind === 'option') fit = end;
          }
          if (fit > 0 && natural - fit > 1) node.style.maxHeight = `${fit}px`;
        }
        viewHeight.current = node.clientHeight;
        lastMetrics = next;
        setMetrics(next);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [shown, rows, placement, metrics, short]);

  useLayoutEffect(() => {
    const node = list.current;
    const row = rows[rowOf[snapshot.index] ?? -1];
    if (!node || !row) return;
    const pointed = byPointer.current;
    byPointer.current = false;
    if (metrics === 'all') {
      node
        .querySelector<HTMLElement>(`#editor-suggest-option-${snapshot.index}`)
        ?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    // Just opened: the selected option is in the lines at the top, which are drawn already.
    if (!viewHeight.current) return;
    if (!pointed) {
      // Keep the option's heading (and the divider above it) in view with it.
      let top = rowTop(row, metrics);
      for (let at = rowOf[snapshot.index]! - 1; at >= 0 && rows[at]!.kind !== 'option'; at -= 1)
        top -= metrics.heading;
      const bottom = rowTop(row, metrics) + metrics.option;
      let next = scrolled.current;
      if (top < next) next = top;
      else if (bottom > next + viewHeight.current) {
        next = bottom - viewHeight.current;
        // A short phone menu scrolls by whole lines (CSS snap): start on the next line's top.
        if (surface.current?.hasAttribute('data-short'))
          for (const line of rows) {
            const lineTop = rowTop(line, metrics);
            if (lineTop >= next - 0.5) {
              next = lineTop;
              break;
            }
          }
      }
      if (next !== scrolled.current) {
        node.scrollTop = next;
        scrolled.current = next;
      }
    }
    show(scrolled.current);
  }, [snapshot.index, rows, rowOf, metrics, show]);

  // An option that cannot go here still shows what it is: its own markup, rendered by itself.
  const previewSource = selected?.unavailable
    ? selected.preview === null
      ? null
      : selected.insert
    : selected?.preview;
  const previewText = useMemo(() => {
    if (!previewSource) return null;
    const text = snapshot.context.definitions
      ? `${snapshot.context.definitions}\n${previewSource}`
      : previewSource;
    return parses(text, globals) ? text : null;
  }, [previewSource, snapshot.context.definitions, globals]);
  const used = useMemo(
    () => (selected?.usage && usage ? usage.count(selected.usage) : undefined),
    [selected, usage],
  );

  if (!placement || !selected) return null;
  const style = {
    '--menu-left': `${placement.left}px`,
    '--menu-top': `${placement.top}px`,
    '--menu-max': `${placement.maxHeight}px`,
  } as CSSProperties;
  const last = rows[rows.length - 1]!;
  // The lines on screen sit in normal flow below one spacer that stands for everything above
  // them. The selected option is always in the document (the editor points at it): when it has
  // been scrolled away it is drawn apart, at its own place.
  // The window was worked out for the list as it was: a list that filtering just made shorter is
  // drawn within its own lines until the scroll position catches up.
  const end = metrics === 'all' ? rows.length : Math.min(rows.length, range ? range.end : topLines);
  const start = metrics === 'all' ? 0 : Math.min(range ? range.start : 0, Math.max(0, end - 1));
  const selectedRow = rowOf[snapshot.index] ?? 0;
  const drawn = rows.slice(start, end);
  if (selectedRow < start || selectedRow >= end) drawn.push(rows[selectedRow]!);
  const above = rows[start]!;
  const note = snapshot.message ?? selected.unavailable;
  return createPortal(
    <div
      ref={surface}
      className={`${styles.menu} ${placement.above ? styles.above : ''}`}
      style={style}
      data-suggest-menu
      data-short={short || undefined}
      // Pressing inside never takes focus from the editor, so the caret and selection stay put.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        ref={list}
        className={styles.list}
        role="listbox"
        id="editor-suggest-list"
        aria-label="Markup suggestions"
        onScroll={(event) => {
          scrolled.current = event.currentTarget.scrollTop;
          show(scrolled.current);
        }}
      >
        <div
          className={styles.rows}
          role="none"
          style={{ '--options': last.options + 1, '--headings': last.headings } as CSSProperties}
        >
          {start > 0 && (
            <div
              className={styles.skipped}
              style={{ '--options': above.options, '--headings': above.headings } as CSSProperties}
            />
          )}
          {drawn.map((row, order) => {
            const apart = order >= end - start;
            const at = apart
              ? ({ '--options': row.options, '--headings': row.headings } as CSSProperties)
              : undefined;
            if (row.kind !== 'option')
              return (
                <div
                  key={`${row.kind}:${row.options}`}
                  className={`${styles.category} ${row.kind === 'divider' ? styles.divider : ''}`}
                  role="presentation"
                  data-suggest-heading={row.kind}
                  data-part={row.part}
                >
                  {row.text}
                </div>
              );
            const item = snapshot.items[row.index]!;
            return (
              <div
                key={item.id}
                id={`editor-suggest-option-${row.index}`}
                role="option"
                aria-selected={row.index === snapshot.index}
                aria-disabled={item.unavailable ? true : undefined}
                aria-setsize={snapshot.items.length}
                aria-posinset={row.index + 1}
                className={apart ? `${styles.option} ${styles.apart}` : styles.option}
                style={at}
                data-category={item.category}
                data-pinned={item.pinned ? '' : undefined}
                title={item.unavailable}
                onMouseMove={() => {
                  if (row.index === snapshot.index) return;
                  byPointer.current = true;
                  moveSuggest(view, row.index, true);
                }}
                onClick={() => acceptSuggestion(view, row.index)}
              >
                <span className={styles.label}>{item.label}</span>
                {item.hint && <span className={styles.hint}>{item.hint}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div className={styles.detail} data-suggest-detail>
        <div className={styles.head}>
          <span className={styles.title}>{selected.label}</span>
          <span className={styles.kind}>{selected.category}</span>
          {/* Touch has no Esc: an explicitly opened menu needs a way out. */}
          <button type="button" className={styles.close} onClick={() => closeSuggest(view)}>
            Close
          </button>
        </div>
        {note && (
          // First under the name, so a short phone sheet never scrolls the reason out of view. Announced
          // once Enter was refused; before that it is the reason the option is greyed.
          <p
            className={styles.note}
            role={snapshot.message ? 'alert' : undefined}
            data-suggest-note
          >
            {note}
          </p>
        )}
        {selected.insert && (
          <pre className={styles.markup} lang={undefined}>
            {selected.insert}
          </pre>
        )}
        {previewText && (
          <div className={styles.rendered} aria-label="Preview">
            <MarkupSnippet text={previewText} lang={lang} globals={globals} />
          </div>
        )}
        <p className={styles.about}>{selected.about}</p>
        {used !== undefined && (
          <p className={styles.usage} data-suggest-usage>
            {used === 0
              ? 'Not used in any tooltip yet'
              : `Used in ${new Intl.NumberFormat().format(used)} ${used === 1 ? 'tooltip' : 'tooltips'}`}
          </p>
        )}
        <p className={styles.keys}>↑↓ choose · Enter or Tab inserts · Esc closes</p>
      </div>
    </div>,
    document.body,
  );
}
