import { describe, expect, it } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import { pickerBands } from './pickerBands';

const sheet = (spans: { row: number; rowSpan: number }[]): CompendiumSheet => ({
  gid: '1',
  name: 'spans',
  rows: [],
  grid: spans.map((span) => ({ ...span, col: 0, cell: { plain: '-', runs: [{ text: '-' }] } })),
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
      { first: 1, last: 12 },
      { first: 13, last: 16 },
      { first: 17, last: 20 },
    ]);
  });
  it('keeps the Armor Mods 19-row span in one band, including a clipped window start', () => {
    expect(pickerBands(sheet([{ row: 2, rowSpan: 19 }]), 5, 21)).toEqual([
      { first: 5, last: 20 },
      { first: 21, last: 21 },
    ]);
    expect(pickerBands(sheet([{ row: 2, rowSpan: 19 }]), 1, 10)).toEqual([{ first: 1, last: 10 }]);
  });
});
