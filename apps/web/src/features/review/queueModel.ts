import { previousCategoryLabel } from '../../services/categoryLabels';
import { isFolded, rowKey, type RowKey } from './globalRows';
import type { Kind } from './kinds';
import type { PendingTooltip } from './model';

/** The one group that holds every migration leftover (marker-only); never a category id. */
export const markerGroup = '~marker-only';
/** The one group of the rows where only translations wait, for editors and maintainers. */
export const translationGroup = '~translation-only';

/** Each row's word, by its key (undefined while not known). */
export type RowKinds = ReadonlyMap<RowKey, Kind | undefined>;

export interface QueueGroup {
  kind: 'group';
  id: string;
  label: string;
  /** Changes in the group after filters. */
  count: number;
  /** Publishable hashes in the group, what its select-all checkbox picks (never leftovers). */
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
  /** Every row that passes the filters, content first, then shown leftovers (collapsed or not). */
  ordered: PendingTooltip[];
  /** Keys of `ordered` rows that are shown, i.e. not inside a collapsed group. */
  shown: Set<RowKey>;
  /** Number of content rows after filters; shown translation-only rows follow, then leftovers. */
  contentCount: number;
  translationCount: number;
  markerCount: number;
}

/** Find matches name, category (current or previous label), and hash; the kind select its word. */
export function matchesFilter(
  entry: PendingTooltip,
  query: string,
  kind: string,
  kinds?: RowKinds,
): boolean {
  if (kind && kinds?.get(rowKey(entry)) !== kind) return false;
  if (!query) return true;
  const { name, category, categoryId, tooltip, lane } = entry;
  const id = lane ? lane.identity : tooltip.hash;
  return `${name} ${category} ${categoryId} ${previousCategoryLabel(categoryId)} ${id}`
    .toLowerCase()
    .includes(query.toLowerCase());
}

/** Leftovers: hidden (the list's "Show" line), or shown as one group, collapsed or open. */
export type Leftovers = 'hidden' | 'collapsed' | 'open';

const views = new WeakMap<PendingTooltip[], Map<string, QueueView>>();
const kindViews = new WeakMap<RowKinds, WeakMap<PendingTooltip[], Map<string, QueueView>>>();

/**
 * Content rows grouped by category (entries arrive sorted by category order), then ONE group per
 * kind of folded row once shown. A kind filter shows only rows of that word, never folded ones. Cached per
 * (entries, filters, collapse state, and the words when filtering by kind): the sidebar and the
 * page ask for the same view in one commit.
 */
export function queueView(
  entries: PendingTooltip[],
  query: string,
  kind: string,
  collapsed: ReadonlySet<string>,
  leftovers: Leftovers,
  kinds?: RowKinds,
  translations: Leftovers = 'hidden',
): QueueView {
  const key = JSON.stringify([query, kind, [...collapsed], leftovers, translations]);
  let cache = views;
  if (kind && kinds) {
    let byKinds = kindViews.get(kinds);
    if (!byKinds) kindViews.set(kinds, (byKinds = new WeakMap()));
    cache = byKinds;
  }
  let byKey = cache.get(entries);
  const cached = byKey?.get(key);
  if (cached) return cached;
  const content: PendingTooltip[] = [];
  const translated: PendingTooltip[] = [];
  const markers: PendingTooltip[] = [];
  for (const entry of entries) {
    if (isFolded(entry)) {
      const [state, rows] = entry.markerOnly ? [leftovers, markers] : [translations, translated];
      if (!kind && state !== 'hidden' && matchesFilter(entry, query, '')) rows.push(entry);
    } else if (matchesFilter(entry, query, kind, kinds)) content.push(entry);
  }
  const items: QueueItem[] = [];
  const shown = new Set<RowKey>();
  for (let start = 0; start < content.length;) {
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

      publishable: [
        ...new Set(
          rows.filter(({ unpublishable }) => !unpublishable).map(({ tooltip }) => tooltip.hash),
        ),
      ],
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (const entry of rows) {
        items.push({ kind: 'row', entry, group: id });
        shown.add(rowKey(entry));
      }
    start = end;
  }
  for (const [id, label, rows, state] of [
    [translationGroup, 'Translations', translated, translations],
    [markerGroup, 'Migration leftovers', markers, leftovers],
  ] as const) {
    if (!rows.length) continue;
    // Shown folded rows start collapsed; they can be opened and ticked one by one.
    const isCollapsed = state !== 'open';
    items.push({
      kind: 'group',
      id,
      label,
      count: rows.length,
      publishable: [],
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (const entry of rows) {
        items.push({ kind: 'row', entry, group: id });
        shown.add(rowKey(entry));
      }
  }
  const view = {
    items,
    ordered: [...content, ...translated, ...markers],
    shown,
    contentCount: content.length,
    translationCount: translated.length,
    markerCount: markers.length,
  };
  if (!byKey) cache.set(entries, (byKey = new Map()));
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
    if (!shown.has(rowKey(ordered[index]!))) continue;
    found = index;
    remaining--;
  }
  return found;
}
