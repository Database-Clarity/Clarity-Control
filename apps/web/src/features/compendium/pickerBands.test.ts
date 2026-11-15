import { describe, expect, it } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import { pickerBands } from './pickerBands';

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
      ...Array.from({ length: 8 }, (_, index) => ({ first: 13 + index, last: 13 + index })),
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
