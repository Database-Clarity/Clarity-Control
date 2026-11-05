import { memo, useMemo } from 'react';
import type { CompendiumRow } from '@clarity/core';
import styles from './Compendium.module.scss';
import gridStyles from './PickerGrid.module.scss';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
      })[char]!,
  );
const labels = new WeakMap<CompendiumRow, string>();

/** Same plain-text controls; one immutable insertion avoids per-row reconciliation. */
export function pickerRowListHtml(
  rows: readonly CompendiumRow[],
  exact: ReadonlySet<CompendiumRow>,
  disabled: boolean,
) {
  return rows
    .map((row, index) => {
      let label = labels.get(row);
      if (label === undefined) {
        label = `${escape(row.name)} ${row.section ? escape(` / ${row.section}`) : ''} <small>(row ${escape(String(row.rowIndex))})</small>`;
        labels.set(row, label);
      }
      return `<li><button type="button" data-picker-row="${index}" data-picker-action="choose"${disabled ? ' disabled' : ''}>${exact.has(row) ? 'Exact match: ' : ''}${label}</button><button type="button" data-picker-row="${index}" data-picker-action="anchor">Pick description cells near this name</button></li>`;
    })
    .join('');
}

export const PickerRowList = memo(function PickerRowList({
  rows,
  exact,
  disabled,
  onChoose,
  onAnchor,
}: {
  rows: readonly CompendiumRow[];
  exact: ReadonlySet<CompendiumRow>;
  disabled: boolean;
  onChoose(row: CompendiumRow): void;
  onAnchor(row: CompendiumRow): void;
}) {
  const shown = useMemo(() => rows.slice(0, 100), [rows]);
  const markup = useMemo(
    () => ({ __html: pickerRowListHtml(shown, exact, disabled) }),
    [shown, exact, disabled],
  );
  return (
    <ul
      className={`${styles.rows} ${gridStyles.rowList}`}
      dangerouslySetInnerHTML={markup}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
          'button[data-picker-row]',
        );
        if (!button || button.disabled || !event.currentTarget.contains(button)) return;
        const row = shown[Number(button.dataset.pickerRow)];
        if (!row) return;
        if (button.dataset.pickerAction === 'choose') onChoose(row);
        else if (button.dataset.pickerAction === 'anchor') onAnchor(row);
      }}
    />
  );
});
