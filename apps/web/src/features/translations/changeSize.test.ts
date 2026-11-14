import { describe, expect, it } from 'vitest';
import { changedWords, changeKey } from './changeSize';
import { sortBySize, type ChangeSize } from './useChangeSizes';
import type { QueueRow } from './queue';

describe('English change sizes', () => {
  it('counts additions and removals, ignores whitespace, and retains repeated words', () => {
    expect(changedWords('A slow perk.', 'A fast perk.')).toBe(2);
    expect(changedWords('A  perk.\n', 'A perk.')).toBe(0);
    expect(changedWords('one one two', 'one two two')).toBe(2);
    expect(changedWords('', 'two new')).toBe(2);
    expect(changedWords('two old', '')).toBe(2);
  });
  it('separates source revisions and same-timestamp English markup changes', () => {
    const request = { hash: 2, sourceUpdatedAt: '2026-01-01', current: 'A perk' };
    expect(changeKey(request)).not.toBe(changeKey({ ...request, current: '<solar A perk/>' }));
    expect(changeKey(request)).not.toBe(changeKey({ ...request, sourceUpdatedAt: '2026-02-01' }));
  });
  it('sorts known sizes first, keeps ties stable, and leaves unknown and missing last', () => {
    const rows = ['unknown', 'large', 'zero', 'same', 'missing', 'failed'].map((key) => ({
      key,
    })) as QueueRow[];
    const sizes = new Map<string, ChangeSize>([
      ['large', { count: 10 }],
      ['zero', { count: 0 }],
      ['same', { count: 0 }],
      ['failed', { error: 'Offline' }],
    ]);
    expect(sortBySize(rows, sizes, true).map((row) => row.key)).toEqual([
      'zero',
      'same',
      'large',
      'unknown',
      'missing',
      'failed',
    ]);
    expect(sortBySize(rows, sizes, false)).toBe(rows);
  });
});
