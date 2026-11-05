import type { CompendiumCell, CompendiumGridCell } from '@clarity/core';

/** Owner-defined separator punctuation has no row-height coupling of its own. */
export function isPickerSeparator(cell: CompendiumCell): boolean {
  return /^[\s\-–—|·•_=.]*$/u.test(cell.plain);
}

/** The current native picker applies vertical-align: top; retain clipped-window placement. */
export function pickerSeparatorLabelRow(
  entry: CompendiumGridCell,
  first: number,
  last: number,
  alignment: 'top' | 'middle' | 'bottom' = 'top',
): number {
  const start = Math.max(first, entry.row);
  const end = Math.min(last, entry.row + (entry.rowSpan ?? 1) - 1);
  return alignment === 'bottom'
    ? end
    : alignment === 'middle'
      ? Math.floor((start + end) / 2)
      : start;
}
