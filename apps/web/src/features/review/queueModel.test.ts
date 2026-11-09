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
  it('groups content rows by category and folds every marker-only row into one collapsed group', () => {
    const view = queueView(entries, '', '', new Set(), false);
    expect(
      view.items.map((item) => (item.kind === 'group' ? `[${item.id}]` : item.entry.tooltip.hash)),
    ).toEqual(['[a]', 1, 2, '[b]', 4, `[${markerGroup}]`]);
    const [a, , , b, , marker] = view.items as QueueGroup[];
    expect(a).toMatchObject({ label: 'Label a', count: 2, publishable: [1] });
    expect(b).toMatchObject({ count: 1, publishable: [4] });
    // The marker-only group never offers a bulk select.
    expect(marker).toMatchObject({ label: 'Marker-only', count: 2, publishable: [], collapsed: true });
    expect(view.ordered.map(({ tooltip }) => tooltip.hash)).toEqual([1, 2, 4, 3, 5]);
    expect([...view.shown]).toEqual([1, 2, 4]);
    expect(view).toMatchObject({ contentCount: 3, markerCount: 2 });
  });

  it('opens the marker group, collapses a category, filters, and caches per state', () => {
    const open = queueView(entries, '', '', new Set(['a']), true);
    expect(
      open.items.map((item) => (item.kind === 'group' ? `[${item.id}]` : item.entry.tooltip.hash)),
    ).toEqual(['[a]', '[b]', 4, `[${markerGroup}]`, 3, 5]);
    expect(queueView(entries, '', '', new Set(['a']), true)).toBe(open);
    const filtered = queueView(entries, 'name 4', '', new Set(), false);
    expect(filtered.ordered.map(({ tooltip }) => tooltip.hash)).toEqual([4]);
    expect(queueView(entries, '', 'b', new Set(), false).markerCount).toBe(1);
  });

  it('steps over rows of collapsed groups, and from a hidden current row', () => {
    const view = queueView(entries, '', '', new Set(['a']), false);
    // ordered: 1, 2, 4 | 3, 5 (marker group collapsed); only 4 is shown.
    expect(stepRow(view, 0, 1)).toBe(2);
    expect(stepRow(view, 2, 1)).toBe(2);
    expect(stepRow(view, 2, -1)).toBe(2);
    const open = queueView(entries, '', '', new Set(), true);
    expect(stepRow(open, 2, 1)).toBe(3);
    expect(stepRow(open, 4, 1)).toBe(4);
    expect(stepRow(open, 0, 10)).toBe(4);
  });
});
