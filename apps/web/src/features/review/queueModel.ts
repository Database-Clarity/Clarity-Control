import { previousCategoryLabel } from '../../services/categoryLabels';
import { rowKey, unitCount, type RowKey } from './globalRows';
import type { Kind } from './kinds';
import type { PendingTooltip } from './model';

/** The one group that holds every migration leftover (marker-only); never a category id. */
export const markerGroup = '~marker-only';

/** The groups of changed globals: unlike categories they start closed, for this visit only. */
export const globalGroupPrefix = '~global:';

/** Each row's word, by its key (undefined while not known). */
export type RowKinds = ReadonlyMap<RowKey, Kind | undefined>;

export interface QueueGroup {
  kind: 'group';
  id: string;
  label: string;
  /** Changes in the group after filters; the rows of one globals file are one change. */
  count: number;
  /** Says which rows are ticked together. */
  note?: string;
  /**
   * Publishable hashes in the group, what its select-all checkbox picks: never leftovers, and never
   * a tooltip with its own edit in a global's group.
   */
  publishable: number[];
  /** A changed global's group ("101 tooltips"), or its line for the tooltips with their own edits. */
  global?: 'all' | 'edited';
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
  /** Content rows; `unitCount` gives the changes they stand for. */
  contentCount: number;
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
  const { name, category, categoryId, tooltip, under } = entry;
  return `${name} ${category} ${categoryId} ${previousCategoryLabel(categoryId)} ${tooltip.hash} ${under?.name ?? ''}`
    .toLowerCase()
    .includes(query.toLowerCase());
}

/** The rows of one globals file share a tick; short, so a narrow list still shows it. */
function togetherNote(rows: readonly PendingTooltip[]): string | undefined {
  const files = new Map<number, string>();
  for (const { tooltip, part } of rows)
    if (part && part.names.length > 1) files.set(tooltip.hash, part.kind);
  if (!files.size) return undefined;
  if (files.size > 1) return 'each kind ticked together';
  const [[hash, kind]] = [...files] as [[number, string]];
  return rows.every(({ tooltip }) => tooltip.hash === hash)
    ? 'ticked together'
    : `${kind} ticked together`;
}

/** Leftovers: hidden (the list's "Show" line), or shown as one group, collapsed or open. */
export type Leftovers = 'hidden' | 'collapsed' | 'open';

const views = new WeakMap<PendingTooltip[], Map<string, QueueView>>();
const kindViews = new WeakMap<RowKinds, WeakMap<PendingTooltip[], Map<string, QueueView>>>();

/**
 * Content rows grouped by category (entries arrive sorted by category order), then ONE leftovers
 * group once shown. A kind filter shows only rows of that word, never leftovers. Cached per
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
): QueueView {
  const key = JSON.stringify([query, kind, [...collapsed], leftovers]);
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
  const markers: PendingTooltip[] = [];
  for (const entry of entries) {
    if (entry.markerOnly) {
      if (!kind && leftovers !== 'hidden' && matchesFilter(entry, query, '')) markers.push(entry);
    } else if (matchesFilter(entry, query, kind, kinds)) content.push(entry);
  }
  const items: QueueItem[] = [];
  const shown = new Set<RowKey>();
  const groupOf = ({ under, categoryId }: PendingTooltip) =>
    under ? `${globalGroupPrefix}${under.id}` : categoryId;
  const addGlobal = (group: QueueGroup, rows: PendingTooltip[]) => {
    // Find and the kind filter open these groups: closed by default, they would hide the matches.
    const filtered = !!(query || kind);
    if (filtered) group.id += ':found';
    group.collapsed = collapsed.has(group.id) === filtered;
    items.push(group);
    if (!group.collapsed)
      for (const entry of rows) {
        items.push({ kind: 'row', entry, group: group.id });
        shown.add(rowKey(entry));
      }
  };
  for (let start = 0; start < content.length;) {
    const id = groupOf(content[start]!);
    let end = start;
    while (end < content.length && groupOf(content[end]!) === id) end++;
    const rows = content.slice(start, end);
    const { under } = rows[0]!;
    start = end;
    if (under) {
      const unedited = rows.filter(({ globals }) => globals?.unedited);
      const edited = rows.filter(({ globals }) => !globals?.unedited);
      const group = { kind: 'group', id, count: rows.length, collapsed: false } as const;
      addGlobal(
        {
          ...group,
          label: under.name,
          publishable: unedited
            .filter(({ unpublishable }) => !unpublishable)
            .map(({ tooltip }) => tooltip.hash),
          global: 'all',
        },
        unedited,
      );
      if (edited.length)
        addGlobal(
          {
            ...group,
            id: `${id}:edited`,
            label: `${edited.length} also ${edited.length === 1 ? 'has its own edit' : 'have their own edits'}`,
            count: edited.length,
            publishable: [],
            global: 'edited',
          },
          edited,
        );
      continue;
    }
    const isCollapsed = collapsed.has(id);
    items.push({
      kind: 'group',
      id,
      label: rows[0]!.category,
      count: unitCount(rows),
      note: togetherNote(rows),
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
  }
  if (markers.length) {
    // Shown leftovers start collapsed; their rows can be opened and ticked one by one.
    const isCollapsed = leftovers !== 'open';
    items.push({
      kind: 'group',
      id: markerGroup,
      label: 'Migration leftovers',
      count: markers.length,
      publishable: [],
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (const entry of markers) {
        items.push({ kind: 'row', entry, group: markerGroup });
        shown.add(rowKey(entry));
      }
  }
  const view = {
    items,
    ordered: [...content, ...markers],
    shown,
    contentCount: content.length,
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
 * A current row that is itself hidden (its group collapsed) still steps from its own position; one
 * opened inside a closed global's group also steps through that group.
 */
export function stepRow(view: QueueView, current: number, delta: number): number {
  const { ordered, shown } = view;
  if (!ordered.length) return -1;
  const direction = Math.sign(delta) || 1;
  const inside = ordered[current]?.under?.id;
  let remaining = Math.abs(delta);
  let index = current;
  let found = current;
  while (remaining > 0) {
    index += direction;
    if (index < 0 || index >= ordered.length) break;
    const row = ordered[index]!;
    if (!shown.has(rowKey(row)) && (!inside || row.under?.id !== inside)) continue;
    found = index;
    remaining--;
  }
  return found;
}
