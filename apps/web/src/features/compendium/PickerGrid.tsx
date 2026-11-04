import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { compendiumCellAt } from '@clarity/core';
import type { CompendiumCellOffset, CompendiumPosition, CompendiumSheet } from '@clarity/core';
import { pickerGridHtml } from './pickerGridMarkup';
import styles from './Compendium.module.scss';

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
  const body = useRef<HTMLTableSectionElement>(null);
  const markup = useMemo(
    () => ({ __html: pickerGridHtml(tab, firstRow, lastRow, columns) }),
    [tab, firstRow, lastRow, columns],
  );
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
  }, [markup, tab, anchor, offsets]);
  return (
    <div
      className={styles.sheetScroll}
      role="region"
      aria-label="Sheet cells around the name anchor"
      tabIndex={0}
    >
      <table
        className={styles.sheet}
        style={{ tableLayout: 'fixed', width: `${5 + columns * 14}rem` }}
        onClick={(event) => {
          const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
            'button[data-row]',
          );
          if (button && !button.disabled && body.current?.contains(button))
            onToggle({
              dRow: Number(button.dataset.row) - anchor.row,
              dCol: Number(button.dataset.col) - anchor.col,
            });
        }}
      >
        <colgroup>
          <col style={{ width: '5rem' }} />
          <col span={columns} style={{ width: '14rem' }} />
        </colgroup>
        <tbody ref={body} dangerouslySetInnerHTML={markup} />
      </table>
    </div>
  );
});
