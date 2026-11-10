import type { QueueRow } from './queue';

/** Where the open tooltip was the last time the queue listed it. */
export interface QueueAnchor {
  hash: number;
  rows: readonly QueueRow[];
  index: number;
}

export interface QueuePlace {
  /** 1-based position in the queue, or 0 when the queue does not list the tooltip. */
  index: number;
  total: number;
  previous: QueueRow | undefined;
  next: QueueRow | undefined;
  /** Not listed now, but it was while open: saved, or changed elsewhere. */
  left: boolean;
}

/**
 * The open tooltip's place in the queue. A tooltip that left the queue while open (its translation
 * was saved) keeps its neighbours through `anchor`: Next is the first row that followed it and is
 * still listed, so nothing is skipped or repeated. Without an anchor (opened when already out of
 * the queue) Next starts at the first row.
 */
export function queuePlace(
  rows: readonly QueueRow[],
  hash: number,
  anchor?: QueueAnchor,
): QueuePlace {
  const index = rows.findIndex((row) => row.hash === hash);
  if (index >= 0)
    return {
      index: index + 1,
      total: rows.length,
      previous: rows[index - 1],
      next: rows[index + 1],
      left: false,
    };
  if (anchor?.hash !== hash)
    return { index: 0, total: rows.length, previous: undefined, next: rows[0], left: false };
  const listed = new Map(rows.map((row) => [row.key, row]));
  let previous: QueueRow | undefined;
  let next: QueueRow | undefined;
  for (let at = anchor.index - 1; at >= 0 && !previous; at--)
    previous = listed.get(anchor.rows[at]!.key);
  for (let at = anchor.index + 1; at < anchor.rows.length && !next; at++)
    next = listed.get(anchor.rows[at]!.key);
  return { index: 0, total: rows.length, previous, next, left: true };
}

/** "12 of 148"; "Done · 147 left" after the open tooltip left the queue. */
export function placeLabel(place: QueuePlace): string {
  if (!place.total) return 'Queue done';
  if (place.index) return `${place.index} of ${place.total}`;
  return `${place.left ? 'Done' : 'Not in queue'} · ${place.total} left`;
}
