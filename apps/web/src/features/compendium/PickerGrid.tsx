import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { compendiumCellAt } from '@clarity/core';
import type { CompendiumCellOffset, CompendiumPosition, CompendiumSheet } from '@clarity/core';
import { pickerGridHtml } from './pickerGridMarkup';
import styles from './Compendium.module.scss';
import gridStyles from './PickerGrid.module.scss';
import { pickerBands, type PickerBand } from './pickerBands';

/**
 * Time a fill task may spend on render and layout before it stops growing its step. A
 * Compendium burst allows 10 ms tasks at a 60 ms cadence; a step may overshoot by a row.
 */
const taskBudgetMs = 6;

const GridBand = memo(function GridBand({
  tab,
  band,
  columns,
  firstRow,
  lastRow,
}: {
  tab: CompendiumSheet;
  band: PickerBand;
  columns: number;
  firstRow: number;
  lastRow: number;
}) {
  const markup = useMemo(
    () => ({ __html: pickerGridHtml(tab, band.first, band.last, columns, firstRow, lastRow) }),
    [tab, band, columns, firstRow, lastRow],
  );
  return (
    <div className={gridStyles.band}>
      <table
        className={styles.sheet}
        style={{ tableLayout: 'fixed', width: `${5 + columns * 14}rem` }}
      >
        <colgroup>
          <col style={{ width: '5rem' }} />
          <col span={columns} style={{ width: '14rem' }} />
        </colgroup>
        <tbody dangerouslySetInnerHTML={markup} />
      </table>
    </div>
  );
});

/** One immutable insertion; React only owns the selection, not thousands of rich text nodes. */
export const PickerGrid = memo(function PickerGrid({
  tab,
  firstRow,
  lastRow,
  columns,
  anchor,
  offsets,
  onToggle,
}: {
  tab: CompendiumSheet;
  firstRow: number;
  lastRow: number;
  columns: number;
  anchor: CompendiumPosition;
  offsets: CompendiumCellOffset[];
  onToggle(offset: CompendiumCellOffset): void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const bands = useMemo(() => pickerBands(tab, firstRow, lastRow), [tab, firstRow, lastRow]);
  const [state, setState] = useState({ bands, count: 1, filled: bands.length < 2 });
  // The height the region had before this window: a new window fills inside it, hidden,
  // rather than collapsing to one band and growing back while the user watches.
  const reserved = useRef<number | undefined>(undefined);
  if (state.bands !== bands) setState({ bands, count: 1, filled: bands.length < 2 });
  const current = state.bands === bands ? state : { bands, count: 1, filled: bands.length < 2 };
  const { count, filled } = current;
  useEffect(() => {
    if (bands.length < 2) return;
    let cancelled = false,
      frame = 0,
      mounted = 1,
      filling = true,
      // Measured render + layout cost per sheet row (a row is hundreds of layout objects); the
      // first measurement is the first band's layout, which also carries first-use font work.
      perRow = 0,
      lastStep = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    const channel = new MessageChannel();
    // Hidden steps follow each other at once (the reveal waits on them). Below the region,
    // steps are timers: they queue behind timers other code set in the meantime (paint
    // stamps that follow the reveal's frame, for one) instead of starving them.
    const next = () =>
      filling ? channel.port2.postMessage(null) : (timer = setTimeout(run, 0));
    // Lays out what is mounted inside this task, never in the frame.
    const layout = () => body.current?.getBoundingClientRect().height ?? 0;
    const rows = (from: number, to: number) => bands[to - 1].last - bands[from].first + 1;
    const run = () => {
      if (cancelled) return;
      const start = performance.now();
      // The first task lays out the first band (mounted with the sheet) and nothing else.
      const first = !perRow;
      if (first) {
        layout();
        perRow = Math.max(performance.now() - start, 0.01) / rows(0, 1);
      }
      for (let step = 0; ; step++) {
        if (filling) {
          // Hidden until the visible region is full; the reveal paints in its own frame.
          const height = layout();
          const available = viewport.current?.clientHeight ?? 0;
          if (mounted >= bands.length || height > available + 1) {
            filling = false;
            flushSync(() => setState({ bands, count: mounted, filled: true }));
            // Same task as the reveal: only the reservation changed since the last layout.
            reserved.current = viewport.current?.clientHeight || undefined;
            // The rest starts after the reveal's frame, registered after this commit's own
            // observers so work that reacts to the reveal is not queued behind the fill.
            if (mounted < bands.length)
              queueMicrotask(() => {
                if (!cancelled) frame = requestAnimationFrame(next);
              });
            return;
          }
        }
        if (mounted >= bands.length) return;
        // Add as many bands as the measured cost fits into this task's budget, so a fast
        // machine finishes in a task or two. No frame waits between tasks: below the region
        // nothing shows, and a frame still runs between tasks when one is due.
        const left = taskBudgetMs - (performance.now() - start);
        if (first && !step && left < perRow) {
          // As before budgeting: the first task also mounts the second band; the next task's
          // height read lays it out (an extra task here is an extra frame before the reveal).
          lastStep = 1;
          flushSync(() => setState({ bands, count: ++mounted, filled: false }));
          return next();
        }
        if (step && left < perRow) return next();
        // Steps keep their unbudgeted sizes (1, then 2 rows while hidden; about 3 rows below
        // the region), so a slow machine takes no more steps than it did. While hidden, the
        // budget only packs more steps into a task (each rechecks the height, so the reveal
        // never waits on rows past the region); below it, steps grow, at most doubling, so
        // one low measurement cannot mount the window at once.
        const least = filling ? (lastStep ? 2 : 1) : 3;
        let end = mounted + 1;
        while (
          end < bands.length &&
          (rows(mounted, end) < least ||
            (!filling && end - mounted < 2 * lastStep && rows(mounted, end + 1) * perRow <= left))
        )
          end++;
        const added = rows(mounted, end);
        const begun = performance.now();
        lastStep = end - mounted;
        mounted = end;
        flushSync(() => setState({ bands, count: mounted, filled: !filling }));
        layout();
        perRow = Math.max(performance.now() - begun, 0.01) / added;
      }
    };
    channel.port1.onmessage = run;
    next();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
    };
  }, [bands]);
  const previousSelection = useRef<{ row: number; col: number }[]>([]);
  const previousLimit = useRef(false);
  useLayoutEffect(() => {
    const anchorCell = compendiumCellAt(tab, anchor);
    for (const previous of body.current!.querySelectorAll('[data-anchor="true"]'))
      previous.removeAttribute('data-anchor');
    if (anchorCell)
      body
        .current!.querySelectorAll(`[data-cell="${anchorCell.row}:${anchorCell.col}"]`)
        .forEach((piece) => piece.setAttribute('data-anchor', 'true'));
    const selectedCells = offsets.map((offset) => ({
      row: anchor.row + offset.dRow,
      col: anchor.col + offset.dCol,
    }));
    const atLimit = offsets.length >= 256;
    // New markup is already unselected. Touch only the old/new selection unless
    // crossing the selection limit requires disabling every other cell.
    const buttons = new Set<HTMLButtonElement>();
    if (atLimit || previousLimit.current)
      for (const button of body.current!.querySelectorAll('button')) buttons.add(button);
    else
      for (const cell of [...previousSelection.current, ...selectedCells])
        for (const button of body.current!.querySelectorAll<HTMLButtonElement>(
          `button[data-row="${cell.row}"][data-col="${cell.col}"]`,
        ))
          buttons.add(button);
    for (const button of buttons) {
      const row = Number(button.dataset.row),
        col = Number(button.dataset.col);
      const selected = offsets.findIndex(
        (offset) => offset.dRow === row - anchor.row && offset.dCol === col - anchor.col,
      );
      const pressed = String(selected >= 0);
      if (button.getAttribute('aria-pressed') !== pressed)
        button.setAttribute('aria-pressed', pressed);
      const disabled = selected < 0 && offsets.length >= 256;
      if (button.disabled !== disabled) button.disabled = disabled;
      let order = button.querySelector('strong');
      if (selected < 0 || button.dataset.separatorLabel === 'false') order?.remove();
      else {
        if (!order) {
          order = document.createElement('strong');
          button.prepend(order);
        }
        const text = `(${selected + 1}) `;
        if (order.textContent !== text) order.textContent = text;
      }
    }
    previousSelection.current = selectedCells;
    previousLimit.current = atLimit;
  }, [count, bands, tab, anchor, offsets]);
  return (
    <div
      ref={viewport}
      className={styles.sheetScroll}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const button =
          target.closest<HTMLButtonElement>('button[data-row]') ??
          target.closest('td[data-separator]')?.querySelector('button');
        if (button && !button.disabled && body.current?.contains(button))
          onToggle({
            dRow: Number(button.dataset.row) - anchor.row,
            dCol: Number(button.dataset.col) - anchor.col,
          });
      }}
      role="region"
      aria-label="Sheet cells around the name anchor"
      data-grid-complete={count === bands.length}
      data-grid-bands={count}
      data-grid-filling={!filled}
      aria-busy={!filled}
      style={filled ? undefined : { visibility: 'hidden', minHeight: reserved.current ?? '36rem' }}
      tabIndex={0}
    >
      <div ref={body} style={{ width: `${5 + columns * 14}rem` }}>
        {bands.slice(0, count).map((band) => (
          <GridBand
            key={band.first}
            tab={tab}
            band={band}
            columns={columns}
            firstRow={firstRow}
            lastRow={lastRow}
          />
        ))}
      </div>
    </div>
  );
});
