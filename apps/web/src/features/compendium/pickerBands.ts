import type { CompendiumSheet } from '@clarity/core';
import { isPickerSeparator } from './pickerSeparators';

export type PickerBand = { first: number; last: number };
/**
 * Fixed columns make bands independent, provided no boundary crosses any rowspan. A band is
 * one row unless a rowspan couples more: each band's layout (including the first use of a
 * sheet font style) then stays its own small task.
 */
export function pickerBands(tab: CompendiumSheet, first: number, last: number): PickerBand[] {
  const bands: PickerBand[] = [];
  const spans = (tab.grid ?? []).filter(
    (cell) => (cell.rowSpan ?? 1) > 1 && !isPickerSeparator(cell.cell),
  );
  for (let row = first; row <= last;) {
    let end = row;
    for (let previous = -1; previous !== end;) {
      previous = end;
      for (const cell of spans) {
        const cellEnd = cell.row + (cell.rowSpan ?? 1) - 1;
        if (cell.row <= end && cellEnd >= row) end = Math.min(last, Math.max(end, cellEnd));
      }
    }
    bands.push({ first: row, last: end });
    row = end + 1;
  }
  return bands;
}
