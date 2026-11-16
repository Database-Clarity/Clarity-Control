import { describe, expect, it } from 'vitest';
import type { PendingTooltip } from './model';
import { markerGroup, queueView, stepRow, type QueueGroup } from './queueModel';

const entry = (
  hash: number,
  categoryId: string,
  { markerOnly = false, unpublishable }: { markerOnly?: boolean; unpublishable?: string } = {},
): PendingTooltip => ({
  tooltip: { hash, text: {}, associated: [] },
  name: `Name ${hash}`,
  category: `Label ${categoryId}`,
  categoryId,
  categoryOrder: 0,
  markerOnly,
  isNew: false,
  ...(unpublishable ? { unpublishable } : {}),
});

// Entries arrive sorted by category; marker-only rows can sit in any category.
const entries = [
  entry(1, 'a'),
  entry(2, 'a', { unpublishable: 'No generator entry' }),
  entry(3, 'a', { markerOnly: true }),
  entry(4, 'b'),
  entry(5, 'b', { markerOnly: true }),
];
describe('queueView', () => {
  it('groups changes by category; leftovers stay out until shown, then form one collapsed group', () => {
    const hidden = queueView(entries, '', '', new Set(), 'hidden');
    expect(
      hidden.items.map((item) =>
        item.kind === 'group' ? `[${item.id}]` : item.entry.tooltip.hash,
      ),
    ).toEqual(['[a]', 1, 2, '[b]', 4]);
    expect(hidden).toMatchObject({ contentCount: 3, markerCount: 0 });
    const view = queueView(entries, '', '', new Set(), 'collapsed');
    expect(
      view.items.map((item) => (item.kind === 'group' ? `[${item.id}]` : item.entry.tooltip.hash)),
    ).toEqual(['[a]', 1, 2, '[b]', 4, `[${markerGroup}]`]);
    const [a, , , b, , marker] = view.items as QueueGroup[];
    expect(a).toMatchObject({ label: 'Label a', count: 2, publishable: [1] });
    expect(b).toMatchObject({ count: 1, publishable: [4] });
    // The leftovers group never offers a bulk select.
    expect(marker).toMatchObject({
      label: 'Migration leftovers',
      count: 2,
      publishable: [],
      collapsed: true,
    });
    expect(view.ordered.map(({ tooltip }) => tooltip.hash)).toEqual([1, 2, 4, 3, 5]);
    expect([...view.shown]).toEqual([1, 2, 4]);
    expect(view).toMatchObject({ contentCount: 3, markerCount: 2 });
  });

  it('opens the leftovers, collapses a category, filters by find and kind, and caches per state', () => {
    const open = queueView(entries, '', '', new Set(['a']), 'open');
    expect(
      open.items.map((item) => (item.kind === 'group' ? `[${item.id}]` : item.entry.tooltip.hash)),
    ).toEqual(['[a]', '[b]', 4, `[${markerGroup}]`, 3, 5]);
    expect(queueView(entries, '', '', new Set(['a']), 'open')).toBe(open);
    const filtered = queueView(entries, 'name 4', '', new Set(), 'hidden');
    expect(filtered.ordered.map(({ tooltip }) => tooltip.hash)).toEqual([4]);
    // Find matches the category too.
    expect(
      queueView(entries, 'label b', '', new Set(), 'hidden').ordered.map(
        ({ tooltip }) => tooltip.hash,
      ),
    ).toEqual([4]);
    // A kind filter shows rows of that word only, never leftovers.
    const kinds = new Map([
      [1, 'New' as const],
      [2, 'On hold' as const],
      [4, 'Text changed' as const],
      [3, 'Leftover' as const],
      [5, 'Leftover' as const],
    ]);
    const news = queueView(entries, '', 'New', new Set(), 'open', kinds);
    expect(news.ordered.map(({ tooltip }) => tooltip.hash)).toEqual([1]);
    expect(news.markerCount).toBe(0);
    // New words are a new view (the cache is per words map).
    const later = new Map(kinds).set(4, 'New');
    expect(
      queueView(entries, '', 'New', new Set(), 'open', later).ordered.map(
        ({ tooltip }) => tooltip.hash,
      ),
    ).toEqual([1, 4]);
  });

  it('steps over rows of collapsed groups, and from a hidden current row', () => {
    const view = queueView(entries, '', '', new Set(['a']), 'collapsed');
    // ordered: 1, 2, 4 | 3, 5 (leftovers collapsed); only 4 is shown.
    expect(stepRow(view, 0, 1)).toBe(2);
    expect(stepRow(view, 2, 1)).toBe(2);
    expect(stepRow(view, 2, -1)).toBe(2);
    const open = queueView(entries, '', '', new Set(), 'open');
    expect(stepRow(open, 2, 1)).toBe(3);
    expect(stepRow(open, 4, 1)).toBe(4);
    expect(stepRow(open, 0, 10)).toBe(4);
  });
});
