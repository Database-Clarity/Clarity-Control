import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { compendiumCellAt } from '@clarity/core';
import type { CompendiumCellOffset, CompendiumPosition, CompendiumSheet } from '@clarity/core';
import { pickerGridHtml } from './pickerGridMarkup';
import styles from './Compendium.module.scss';
import gridStyles from './PickerGrid.module.scss';
import { pickerBands, type PickerBand } from './pickerBands';

const GridBand = memo(function GridBand({
  tab,
  band,
  columns,
}: {
  tab: CompendiumSheet;
  band: PickerBand;
  columns: number;
}) {
  const markup = useMemo(
    () => ({ __html: pickerGridHtml(tab, band.first, band.last, columns) }),
    [tab, band, columns],
  );
  return (
    <table
      className={`${styles.sheet} ${gridStyles.band}`}
      style={{ tableLayout: 'fixed', width: `${5 + columns * 14}rem` }}
    >
      <colgroup>
        <col style={{ width: '5rem' }} />
        <col span={columns} style={{ width: '14rem' }} />
      </colgroup>
      <tbody dangerouslySetInnerHTML={markup} />
    </table>
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
  const [state, setState] = useState({ bands, count: 1 });
  if (state.bands !== bands) setState({ bands, count: 1 });
  const count = state.bands === bands ? state.count : 1;
  useEffect(() => {
    if (bands.length < 2 || typeof ResizeObserver === 'undefined') {
      setState({ bands, count: bands.length });
      return;
    }
    let cancelled = false,
      frame = 0;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (!cancelled)
        setState((current) =>
          current.bands === bands
            ? { bands, count: Math.min(bands.length, current.count + 1) }
            : current,
        );
    };
    let contentHeight = 0,
      viewportHeight = 0,
      first = true;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === body.current) contentHeight = entry.contentRect.height;
        if (entry.target === viewport.current) viewportHeight = entry.contentRect.height;
      }
      if (!first || !contentHeight || !viewportHeight) return;
      first = false;
      observer.disconnect();
      // No guessed heights or empty visible bands: when the first band does not
      // overflow the pane, finish before its first paint. A small sheet simply
      // stays complete; a large rowspan remains one indivisible layout.
      if (contentHeight <= viewportHeight + 1)
        flushSync(() => setState({ bands, count: bands.length }));
      else
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => channel.port2.postMessage(null));
        });
    });
    observer.observe(body.current!);
    observer.observe(viewport.current!);
    return () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      channel.port1.close();
      channel.port2.close();
    };
  }, [bands]);
  useEffect(() => {
    if (count <= 1 || count >= bands.length) return;
    let frame = 0;
    const channel = new MessageChannel();
    channel.port1.onmessage = () =>
      setState((current) =>
        current.bands === bands
          ? { bands, count: Math.min(bands.length, current.count + 1) }
          : current,
      );
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => channel.port2.postMessage(null));
    });
    return () => {
      cancelAnimationFrame(frame);
      channel.port1.close();
      channel.port2.close();
    };
  }, [bands, count]);
  useLayoutEffect(() => {
    const anchorCell = compendiumCellAt(tab, anchor);
    const previousAnchor = body.current!.querySelector('[data-anchor="true"]');
    previousAnchor?.removeAttribute('data-anchor');
    if (anchorCell)
      body
        .current!.querySelector(`[data-cell="${anchorCell.row}:${anchorCell.col}"]`)
        ?.setAttribute('data-anchor', 'true');
    for (const button of body.current!.querySelectorAll('button')) {
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
      if (selected < 0) order?.remove();
      else {
        if (!order) {
          order = document.createElement('strong');
          button.prepend(order);
        }
        const text = `(${selected + 1}) `;
        if (order.textContent !== text) order.textContent = text;
      }
    }
  }, [count, bands, tab, anchor, offsets]);
  return (
    <div
      ref={viewport}
      className={styles.sheetScroll}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-row]');
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
      tabIndex={0}
    >
      <div ref={body} style={{ width: `${5 + columns * 14}rem` }}>
        {bands.slice(0, count).map((band) => (
          <GridBand key={band.first} tab={tab} band={band} columns={columns} />
        ))}
      </div>
    </div>
  );
});
