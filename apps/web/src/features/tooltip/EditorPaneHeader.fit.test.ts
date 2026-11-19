import { describe, expect, it } from 'vitest';
import { nextFit } from './EditorPaneHeader';

// The desktop tool line: 513px of room (1280 window, maintainer), More 30px with its gap, the
// tools it takes (Add to worklist, Move to Inactive, Grouped) 180px.
describe('desktop tool line fit', () => {
  it('keeps every tool inline while the line fits', () => {
    expect(nextFit('full', 500, 513, 180, 30)).toBe('full');
  });
  it('moves the spare tools to More when the line does not fit (a draft adds Discard)', () => {
    expect(nextFit('full', 575, 513, 180, 30)).toBe('spill');
  });
  it('wraps only when even the line without them does not fit', () => {
    expect(nextFit('full', 900, 513, 180, 30)).toBe('spill-wrap');
    expect(nextFit('spill', 720, 513, 180, 30)).toBe('spill-wrap');
  });
  it('wraps a line with nothing to move instead of clipping it', () => {
    expect(nextFit('full', 600, 513, 0, 30)).toBe('wrap');
  });
  it('brings the tools back once the whole line fits again, and not before', () => {
    // Spilled: the line is 425px now; inline it would be 425 - 30 + 180 = 575.
    expect(nextFit('spill', 425, 513, 180, 30)).toBe('spill');
    expect(nextFit('spill', 425, 580, 180, 30)).toBe('full');
  });
  it('is stable: an answer never flips on the measurement it produces', () => {
    const room = 513;
    const inline = 560;
    const spilled = inline - 180 + 30;
    expect(nextFit('full', inline, room, 180, 30)).toBe('spill');
    expect(nextFit('spill', spilled, room, 180, 30)).toBe('spill');
  });
});
