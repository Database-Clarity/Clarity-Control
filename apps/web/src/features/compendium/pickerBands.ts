import type { CompendiumSheet } from '@clarity/core';

export type PickerBand = { first: number; last: number };
/** Fixed columns make bands independent, provided no boundary crosses any rowspan. */
export function pickerBands(tab: CompendiumSheet, first: number, last: number): PickerBand[] {
  const bands: PickerBand[] = [];
  for (let row = first; row <= last;) {
    let end = Math.min(last, row + 3);
    for (let previous = -1; previous !== end;) {
      previous = end;
      for (const cell of tab.grid ?? []) {
        const cellEnd = cell.row + (cell.rowSpan ?? 1) - 1;
        if (cell.row <= end && cellEnd >= row) end = Math.min(last, Math.max(end, cellEnd));
      }
    }
    bands.push({ first: row, last: end });
    row = end + 1;
  }
  return bands;
}
