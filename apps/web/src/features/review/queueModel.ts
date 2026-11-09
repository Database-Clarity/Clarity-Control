import { previousCategoryLabel } from '../../services/categoryLabels';
import type { PendingTooltip } from './model';

/** The one group that holds every marker-only leftover; never a category id. */
export const markerGroup = '~marker-only';

export interface QueueGroup {
  kind: 'group';
  id: string;
  label: string;
  /** Rows in the group after filters. */
  count: number;
  /** Publishable hashes in the group, what its select-all checkbox picks (never marker-only). */
  publishable: number[];
  collapsed: boolean;
}
export interface QueueRow {
  kind: 'row';
  entry: PendingTooltip;
  group: string;
}
export type QueueItem = QueueGroup | QueueRow;

export interface QueueView {
  /** The left column's flat item model: group headers and the rows of expanded groups. */
  items: QueueItem[];
  /** Every row that passes the filters, content first, then marker-only (collapsed or not). */
  ordered: PendingTooltip[];
  /** Hashes of `ordered` rows that are shown, i.e. not inside a collapsed group. */
  shown: Set<number>;
  contentCount: number;
  markerCount: number;
}

export function matchesFilter(
  { name, category, categoryId, tooltip }: PendingTooltip,
  query: string,
  categoryFilter: string,
): boolean {
  if (categoryFilter && categoryId !== categoryFilter) return false;
  if (!query) return true;
  return `${name} ${category} ${categoryId} ${previousCategoryLabel(categoryId)} ${tooltip.hash}`
    .toLowerCase()
    .includes(query.toLowerCase());
}

const views = new WeakMap<PendingTooltip[], Map<string, QueueView>>();

/**
 * Content rows grouped by category (entries arrive sorted by category order), then ONE marker-only
 * group, collapsed unless opened. Cached per (entries, filters, collapse state): the sidebar and
 * the page ask for the same view in one commit.
 */
export function queueView(
  entries: PendingTooltip[],
  query: string,
  categoryFilter: string,
  collapsed: ReadonlySet<string>,
  markerOpen: boolean,
): QueueView {
  const key = `${query}\u0000${categoryFilter}\u0000${[...collapsed].join('\u0001')}\u0000${markerOpen}`;
  let byKey = views.get(entries);
  const cached = byKey?.get(key);
  if (cached) return cached;
  const content: PendingTooltip[] = [];
  const markers: PendingTooltip[] = [];
  for (const entry of entries) {
    if (!matchesFilter(entry, query, categoryFilter)) continue;
    (entry.markerOnly ? markers : content).push(entry);
  }
  const items: QueueItem[] = [];
  const shown = new Set<number>();
  for (let start = 0; start < content.length; ) {
    const id = content[start]!.categoryId;
    let end = start;
    while (end < content.length && content[end]!.categoryId === id) end++;
    const rows = content.slice(start, end);
    const isCollapsed = collapsed.has(id);
    items.push({
      kind: 'group',
      id,
      label: rows[0]!.category,
      count: rows.length,
      publishable: rows
        .filter(({ unpublishable }) => !unpublishable)
        .map(({ tooltip }) => tooltip.hash),
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (const entry of rows) {
        items.push({ kind: 'row', entry, group: id });
        shown.add(entry.tooltip.hash);
      }
    start = end;
  }
  if (markers.length) {
    items.push({
      kind: 'group',
      id: markerGroup,
      label: 'Marker-only',
      count: markers.length,
      publishable: [],
      collapsed: !markerOpen,
    });
    if (markerOpen)
      for (const entry of markers) {
        items.push({ kind: 'row', entry, group: markerGroup });
        shown.add(entry.tooltip.hash);
      }
  }
  const view = {
    items,
    ordered: [...content, ...markers],
    shown,
    contentCount: content.length,
    markerCount: markers.length,
  };
  if (!byKey) views.set(entries, (byKey = new Map()));
  // Filters and collapse states are few; keep only the latest handful per snapshot.
  if (byKey.size > 16) byKey.clear();
  byKey.set(key, view);
  return view;
}

/**
 * The next shown row from `current` in `delta` direction, skipping rows of collapsed groups.
 * A current row that is itself hidden (its group collapsed) still steps from its own position.
 */
export function stepRow(view: QueueView, current: number, delta: number): number {
  const { ordered, shown } = view;
  if (!ordered.length) return -1;
  const direction = Math.sign(delta) || 1;
  let remaining = Math.abs(delta);
  let index = current;
  let found = current;
  while (remaining > 0) {
    index += direction;
    if (index < 0 || index >= ordered.length) break;
    if (!shown.has(ordered[index]!.tooltip.hash)) continue;
    found = index;
    remaining--;
  }
  return found;
}
