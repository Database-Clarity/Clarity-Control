import { describe, expect, it } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import { pickerBands, pickerBandUsesGrid } from './pickerBands';

const sheet = (spans: { row: number; rowSpan: number }[]): CompendiumSheet => ({
  gid: '1',
  name: 'spans',
  rows: [],
  grid: spans.map((span) => ({
    ...span,
    col: 0,
    cell: { plain: 'content', runs: [{ text: 'content' }] },
  })),
});
describe('independent picker row bands', () => {
  it('keeps meaningful vertical spans native even when clipped to one visible row', () => {
    const tab = sheet([{ row: 2, rowSpan: 5 }]);
    expect(pickerBandUsesGrid(tab, { first: 4, last: 4 })).toBe(false);
    expect(pickerBandUsesGrid(tab, { first: 1, last: 1 })).toBe(true);
    tab.grid![0].cell = { plain: '-', runs: [{ text: '-' }] };
    expect(pickerBandUsesGrid(tab, { first: 4, last: 4 })).toBe(true);
  });
  it('closes intersecting spans transitively before choosing the next boundary', () => {
    expect(
      pickerBands(
        sheet([
          { row: 2, rowSpan: 5 },
          { row: 6, rowSpan: 7 },
        ]),
        1,
        20,
      ),
    ).toEqual([
      { first: 1, last: 1 },
      { first: 2, last: 12 },
      ...Array.from({ length: 8 }, (_, i) => ({ first: i + 13, last: i + 13 })),
    ]);
  });
  it('keeps a non-separator 19-row span in one band, including a clipped window start', () => {
    expect(pickerBands(sheet([{ row: 2, rowSpan: 19 }]), 5, 21)).toEqual([
      { first: 5, last: 20 },
      { first: 21, last: 21 },
    ]);
    expect(pickerBands(sheet([{ row: 2, rowSpan: 19 }]), 1, 10)).toEqual([
      { first: 1, last: 1 },
      { first: 2, last: 10 },
    ]);
  });
});
