import { expect, it } from 'vitest';
import { applyWorklistOperation, storedWorklistSchema } from './worklists';
it('applies idempotent operations without dropping unrelated server entries', () => {
  const row = { name: 'A', hashes: [1, 3] };
  const added = applyWorklistOperation(row, { type: 'add', hashes: [1, 2] })!;
  expect(added.hashes).toEqual([1, 3, 2]);
  expect(applyWorklistOperation(added, { type: 'add', hashes: [1, 2] })).toEqual(added);
  expect(applyWorklistOperation(added, { type: 'remove', hashes: [1] })).toEqual({
    name: 'A',
    hashes: [3, 2],
  });
  expect(applyWorklistOperation(added, { type: 'move', hash: 2, index: 0 })!.hashes).toEqual([
    2, 1, 3,
  ]);
  expect(applyWorklistOperation(null, { type: 'add', hashes: [2] })).toBeNull();
  expect(
    storedWorklistSchema.safeParse({ name: 'A', hashes: Array.from({ length: 3499 }, (_, i) => i) })
      .success,
  ).toBe(false);
});
