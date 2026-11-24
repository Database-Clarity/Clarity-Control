import { describe, expect, it } from 'vitest';
import { nextFit } from './EditorPaneHeader';

// The desktop tool line: 513px of room (1280 window, maintainer). The spare tools in spill order,
// each with its gap: Grouped 54, Move to Inactive 40, Add to worklist 102. More: 30 with its gap.
const tools = [54, 40, 102];
const more = 30;
const fit = (moved: number, wrap = false) => ({ moved, wrap });

describe('desktop tool line fit', () => {
  it('keeps every tool inline while the line fits', () => {
    expect(nextFit(500, 513, tools, 0, more)).toEqual(fit(0));
  });
  it('moves only as many tools as the line needs, the rarest first', () => {
    // 20px over: Grouped alone (54 out, More 30 in) is enough.
    expect(nextFit(533, 513, tools, 0, more)).toEqual(fit(1));
    // 60px over: Grouped and Move to Inactive (94 out, More 30 in).
    expect(nextFit(573, 513, tools, 0, more)).toEqual(fit(2));
    // 150px over: all three.
    expect(nextFit(663, 513, tools, 0, more)).toEqual(fit(3));
  });
  it('wraps only when even every tool in More does not fit', () => {
    expect(nextFit(900, 513, tools, 0, more)).toEqual(fit(3, true));
  });
  it('wraps a line with nothing to move instead of clipping it', () => {
    expect(nextFit(600, 513, [], 0, more)).toEqual(fit(0, true));
  });
  it('brings tools back one at a time as room comes back', () => {
    // Two in More: the line is 573 - 94 + 30 = 509 now.
    expect(nextFit(509, 513, tools, 2, more)).toEqual(fit(2));
    expect(nextFit(509, 560, tools, 2, more)).toEqual(fit(1));
    expect(nextFit(509, 580, tools, 2, more)).toEqual(fit(0));
  });
  it('does not flip at an exact fit when scrollWidth rounds one of the two layouts', () => {
    // Full Auto Trigger System in a 625px line: the same width measures 625.64, then 625.2.
    const spare = [66.59375, 45.5, 127.046875, 70.34375];
    expect(nextFit(625.640625, 625, spare, 3, 37.5)).toEqual(fit(4));
    expect(nextFit(554.859375, 625, spare, 4, 37.5)).toEqual(fit(4));
  });
  it('is stable: an answer never flips on the measurement it produces', () => {
    for (const inline of [520, 560, 620, 700]) {
      const first = nextFit(inline, 513, tools, 0, more);
      const moved = tools.slice(0, first.moved).reduce((sum, width) => sum + width, 0);
      const now = inline - moved + (first.moved ? more : 0);
      expect(nextFit(now, 513, tools, first.moved, more)).toEqual(first);
    }
  });
});
