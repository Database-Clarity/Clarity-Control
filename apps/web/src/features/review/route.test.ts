import { expect, it } from 'vitest';
import { initialReviewParams } from './route';
import type { PendingTooltip } from './model';

const entries = [
  { name: 'Alpha', category: 'Armor', categoryId: 'armor', tooltip: { hash: 1 } },
  { name: 'Beta', category: 'Weapons', categoryId: 'weapon', tooltip: { hash: 2 } },
] as PendingTooltip[];
it('keeps the prepared selection in the same filtered URL without a second page render', () => {
  expect(initialReviewParams(new URLSearchParams(), entries).toString()).toBe('hash=1');
  expect(
    initialReviewParams(
      new URLSearchParams('category=weapon&hash=1&other=kept'),
      entries,
    ).toString(),
  ).toBe('category=weapon&hash=2&other=kept');
  expect(initialReviewParams(new URLSearchParams('query=ARMOR&hash=2'), entries).get('hash')).toBe(
    '1',
  );
  expect(initialReviewParams(new URLSearchParams('hash=2'), entries).get('hash')).toBe('2');
  expect(initialReviewParams(new URLSearchParams('category=none&hash=2'), entries).toString()).toBe(
    'category=none',
  );
});
