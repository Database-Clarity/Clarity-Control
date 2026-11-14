/**
 * Work-through queues: one model for every worklist that can be worked through in the editor
 * (Bungie drift, Lost text, Archive; later Review changes and Translations).
 *
 * Membership is frozen when the queue starts: the items the list showed (or the ones selected),
 * in the list's order. Nothing joins or reorders behind the user's back; "Rebuild queue" asks the
 * source list again, explicitly. Each item's status is
 * - done: the list's own completion test says the work is finished (saved, marked reviewed,
 *   recovered or dismissed, staged...). It is read live, so a discarded draft reopens the item.
 * - skipped: stepped past with Next while still open.
 * - open: neither.
 *
 * Positions count the items still to do (open and skipped), as the translator queue always did:
 * "12 of 148" is the 12th of 148 left, and an item finished while open reads "Done · 147 left".
 */
import type { Lang } from '@clarity/core';

/** The worklists a queue can come from. */
export type QueueSourceId = 'review' | 'drift' | 'lost-text' | 'archive' | 'translations';

export type ItemStatus = 'open' | 'done' | 'skipped';

export interface QueueItem {
  /** Unique within the queue (a tooltip can be listed once per language). */
  key: string;
  /** The tooltip the item opens. */
  hash: number;
  lang?: Lang;
  /** The list's own name for the row, kept so the queue reads the same if the catalog changes. */
  name: string;
  /** What the source needs to judge or finish the item (a lost-text record, a starting state). */
  detail?: unknown;
  /**
   * Where the item opens in the editor: the canonical tooltip with `variant=` for an enhanced
   * override (a plain `/t/<override>` redirects to its base and loses the override).
   */
  path?: string;
}

export interface WorkQueue {
  version: 1;
  id: string;
  source: QueueSourceId;
  /** "selected": the rows the user ticked; "shown": every row the list's filters showed. */
  scope: 'selected' | 'shown';
  /**
   * The list it came from: the page to go back to and the list's own state (filters, selection,
   * scroll), restored on Leave and used again by Rebuild queue.
   */
  origin: { path: string; restore: unknown };
  items: QueueItem[];
  /** Items stepped past while open. */
  skipped: string[];
  /** The item last opened in queue mode. */
  current: string;
  /** Set by Next on the last item (or by finishing it); cleared by Revisit skipped or Rebuild. */
  finished: boolean;
  createdAt: number;
  /**
   * Reserved for scheduled changes (batch destinations): the queue model keeps a place for a
   * destination, but none is built yet. Always null.
   */
  destination: null;
}

/** The queue a route belongs to, carried in the history entry's state next to an unchanged URL. */
export interface QueueVisit {
  id: string;
  key: string;
  /** Revisit from the end of the queue: it leaves the end state once this item opens. */
  revisit?: boolean;
}

export function visitState(visit: QueueVisit): { workThrough: QueueVisit } {
  return {
    workThrough: { id: visit.id, key: visit.key, ...(visit.revisit ? { revisit: true } : {}) },
  };
}

/** The queue visit in a history entry's state, or null on an ordinary visit. */
export function visitOf(state: unknown): QueueVisit | null {
  const visit = (state as { workThrough?: Partial<QueueVisit> } | null)?.workThrough;
  if (!visit || typeof visit !== 'object') return null;
  return typeof visit.id === 'string' && typeof visit.key === 'string'
    ? { id: visit.id, key: visit.key, ...(visit.revisit === true ? { revisit: true } : {}) }
    : null;
}

export function statusOf(
  queue: Pick<WorkQueue, 'skipped'>,
  item: QueueItem,
  isDone: (item: QueueItem) => boolean,
): ItemStatus {
  if (isDone(item)) return 'done';
  return queue.skipped.includes(item.key) ? 'skipped' : 'open';
}

export interface QueuePlace {
  /** 1-based position among the items still to do; 0 when the current item is done. */
  index: number;
  /** Items still to do (open and skipped). */
  left: number;
  skipped: number;
  previous: QueueItem | undefined;
  next: QueueItem | undefined;
  /** Every item is done, or the user went past the last one. */
  finished: boolean;
  /** The current item, when the queue lists it. */
  current: QueueItem | undefined;
  status: ItemStatus | undefined;
}

/**
 * Where `key` sits in the queue. Previous and Next step over the items still to do, in the
 * queue's order; a done item keeps its neighbours, so nothing is skipped or repeated.
 */
export function queuePlace(
  queue: WorkQueue,
  key: string,
  isDone: (item: QueueItem) => boolean,
): QueuePlace {
  const statuses = queue.items.map((item) => statusOf(queue, item, isDone));
  const at = queue.items.findIndex((item) => item.key === key);
  let left = 0;
  let skipped = 0;
  let index = 0;
  let previous: QueueItem | undefined;
  let next: QueueItem | undefined;
  queue.items.forEach((item, position) => {
    const status = statuses[position]!;
    if (status === 'done') return;
    left++;
    if (status === 'skipped') skipped++;
    if (position === at) index = left;
    else if (at >= 0 && position < at) previous = item;
    // Not listed (the item left on a rebuild): Next starts at the first item still to do.
    else if (position > at && !next) next = item;
  });
  const current = at >= 0 ? queue.items[at] : undefined;
  return {
    index,
    left,
    skipped,
    previous,
    next,
    finished: left === 0 || queue.finished,
    current,
    status: at >= 0 ? statuses[at] : undefined,
  };
}

/**
 * "12 of 148"; "Done · 147 left" once the open item is finished; "Queue done" when nothing is
 * left; "End · 2 skipped" after Next on the last item with skipped ones behind.
 */
export function placeLabel(place: QueuePlace): string {
  if (!place.left) return 'Queue done';
  if (place.finished)
    return place.skipped === place.left
      ? `End · ${place.skipped} skipped`
      : `End · ${place.left} left`;
  if (place.index) return `${place.index} of ${place.left}`;
  return `${place.status === 'done' ? 'Done' : 'Not in queue'} · ${place.left} left`;
}

/** The first item still to do, from the start (or the first skipped one when `skippedOnly`). */
export function firstToDo(
  queue: WorkQueue,
  isDone: (item: QueueItem) => boolean,
  skippedOnly = false,
): QueueItem | undefined {
  return queue.items.find(
    (item) => !isDone(item) && (!skippedOnly || queue.skipped.includes(item.key)),
  );
}

/** A new queue id: random enough for one browser tab's session. */
export function newQueueId(): string {
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Items for `rows`, keeping the queue's own record of any it already holds. */
export function merged(queue: WorkQueue, rows: QueueItem[]): QueueItem[] {
  const old = new Map(queue.items.map((item) => [item.key, item]));
  const selected =
    queue.scope === 'selected'
      ? new Set((queue.origin.restore as { selected?: unknown[] }).selected?.map(String))
      : undefined;
  return rows
    .filter((row) => !selected || selected.has(row.key))
    .map((row) => {
      // A kept item keeps its starting state; where it opens follows the current catalog.
      const kept = old.get(row.key);
      if (!kept) return row;
      return row.path === undefined ? kept : { ...kept, path: row.path };
    });
}
