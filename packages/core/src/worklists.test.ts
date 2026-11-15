import { describe, expect, it } from 'vitest';
import { mergeWorklists, worklistsSchema, type SavedWorklist } from './worklists';
const list = (id: string, hashes: number[]): SavedWorklist => ({
  id,
  name: id,
  items: hashes.map((hash) => ({ hash, name: String(hash) })),
});
describe('worklist conflict recovery', () => {
  it('preserves ids, order, and every distinct item across concurrent additions', () => {
    const a = list('a', [1, 2]);
    const b = list('b', [5]);
    const merged = mergeWorklists([a], [list('a', [2, 3]), b]);
    expect(merged.map((list) => list.id)).toEqual(['a', 'b']);
    expect(merged[0]!.items.map((item) => item.hash)).toEqual([1, 2, 3]);
    expect(a.items).toHaveLength(2);
  });
  it('keeps over-limit recovery intact for explicit resolution', () => {
    const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
    const merged = mergeWorklists(
      [
        list(
          id,
          Array.from({ length: 500 }, (_, i) => i),
        ),
      ],
      [list(id, [501])],
    );
    expect(merged[0]!.items).toHaveLength(501);
    expect(worklistsSchema.safeParse(merged).success).toBe(false);
  });
});
