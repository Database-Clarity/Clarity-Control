import { describe, expect, it } from 'vitest';
import { nameFloorRem, nameSizeRem, nameWidthEm } from './nameFit';

describe('nameWidthEm', () => {
  it('is deterministic, grows with the name, and counts the header letter-spacing', () => {
    // jsdom has no canvas: the estimate is 0.7em per glyph less 0.02em of letter-spacing.
    expect(nameWidthEm('Celerity')).toBeCloseTo(8 * 0.68, 5);
    expect(nameWidthEm('Celerity')).toBe(nameWidthEm('celerity'));
    expect(nameWidthEm('Unforeseen Repercussions')).toBeGreaterThan(nameWidthEm('Celerity'));
  });

  it('floors the shrink at 75% of the full size', () => {
    expect(nameFloorRem / nameSizeRem).toBeCloseTo(0.75, 5);
  });
});
