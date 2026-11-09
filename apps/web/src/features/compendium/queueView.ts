import { kindLabels, showMatches, type QueueKind, type QueueRow, type ShowFilter } from './queueRows';

export interface CategoryInfo {
  id: string;
  label: string;
  order: number;
}

export type QueueItem =
  | {
      type: 'header';
      key: string;
      /** Category id, or `not-needed`. */
      group: string;
      label: string;
      count: number;
      collapsed: boolean;
    }
  | {
      type: 'row';
      key: number;
      row: QueueRow;
      /** The entry was opened from the editor and is hidden by the current filters. */
      pinned?: boolean;
    };

export interface QueueFilters {
  show: ShowFilter;
  query: string;
  /** Narrow to one category id. */
  group: string;
}

export const notNeededGroup = 'not-needed';

function matchesQuery(row: QueueRow, query: string): boolean {
  if (!query) return true;
  return `${row.name} ${row.hash}`.toLowerCase().includes(query);
}

/** Rows passing the filters, in catalog order then name. `rows` is already sorted that way. */
export function filterRows(rows: readonly QueueRow[], filters: QueueFilters): QueueRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      row.kind !== 'not-needed' &&
      showMatches(filters.show, row.kind) &&
      (!filters.group || row.category === filters.group) &&
      matchesQuery(row, query),
  );
}

/** Not-needed rows are a group of their own, listed with the open and all views. */
export function notNeededRows(rows: readonly QueueRow[], filters: QueueFilters): QueueRow[] {
  if (filters.show !== 'open' && filters.show !== 'all') return [];
  const query = filters.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      row.kind === 'not-needed' &&
      (!filters.group || row.category === filters.group) &&
      matchesQuery(row, query),
  );
}

/** Catalog category order, then name, then hash. */
export function sortRows(rows: QueueRow[], categories: ReadonlyMap<string, CategoryInfo>) {
  const order = (id: string) => categories.get(id)?.order ?? 9999;
  return rows.sort(
    (a, b) =>
      order(a.category) - order(b.category) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name) ||
      a.hash - b.hash,
  );
}

export function categoryLabel(categories: ReadonlyMap<string, CategoryInfo>, id: string) {
  return categories.get(id)?.label ?? `Other: ${id}`;
}

export interface BuildInput {
  rows: readonly QueueRow[];
  filters: QueueFilters;
  categories: ReadonlyMap<string, CategoryInfo>;
  /** Groups the user flipped from their default (open, except Not needed which starts closed). */
  toggled: ReadonlySet<string>;
  /** The route's `hash`, pinned visible when the filters would hide it. */
  hash?: number;
}

export interface QueueModel {
  items: QueueItem[];
  /** Rows reachable by stepping (headers collapsed away), in list order. */
  steps: QueueRow[];
  /** Rows passing the filters, including those in collapsed groups. */
  visible: number;
}

/** The flat list model: group headers and rows, with collapsed groups folded away. */
export function buildQueue({ rows, filters, categories, toggled, hash }: BuildInput): QueueModel {
  const shown = filterRows(rows, filters);
  const notNeeded = notNeededRows(rows, filters);
  const items: QueueItem[] = [];
  const steps: QueueRow[] = [];
  const pinned =
    hash !== undefined &&
    !shown.some((row) => row.hash === hash) &&
    !notNeeded.some((row) => row.hash === hash)
      ? rows.find((row) => row.hash === hash)
      : undefined;
  if (pinned) {
    items.push({ type: 'row', key: pinned.hash, row: pinned, pinned: true });
    steps.push(pinned);
  }
  let index = 0;
  while (index < shown.length) {
    const category = shown[index].category;
    let end = index;
    while (end < shown.length && shown[end].category === category) end++;
    const isCollapsed = toggled.has(category);
    items.push({
      type: 'header',
      key: `group:${category}`,
      group: category,
      label: categoryLabel(categories, category),
      count: end - index,
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (let i = index; i < end; i++) {
        items.push({ type: 'row', key: shown[i].hash, row: shown[i] });
        steps.push(shown[i]);
      }
    index = end;
  }
  if (notNeeded.length) {
    const isCollapsed = !toggled.has(notNeededGroup);
    items.push({
      type: 'header',
      key: `group:${notNeededGroup}`,
      group: notNeededGroup,
      label: 'Not needed',
      count: notNeeded.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (const row of notNeeded) {
        items.push({ type: 'row', key: row.hash, row });
        steps.push(row);
      }
  }
  return { items, steps, visible: shown.length + notNeeded.length };
}

/** The row to select: the route's, else the first stepped row. */
export function selectedRow(
  rows: readonly QueueRow[],
  steps: readonly QueueRow[],
  hash?: number,
): QueueRow | undefined {
  return (hash !== undefined ? rows.find((row) => row.hash === hash) : undefined) ?? steps[0];
}

/** The row to move to after a decision, skipping rows that no longer need the user. */
export function nextOpenRow(steps: readonly QueueRow[], from: number): QueueRow | undefined {
  const index = steps.findIndex((row) => row.hash === from);
  const open: QueueKind[] = ['proposal', 'candidates', 'none', 'changed'];
  const after = steps.slice(index + 1).find((row) => open.includes(row.kind));
  if (after) return after;
  // Wrap to the first earlier open row so the last decision never strands the user.
  return steps.slice(0, Math.max(0, index)).find((row) => open.includes(row.kind));
}

export function kindText(kind: QueueKind) {
  return kindLabels[kind];
}
