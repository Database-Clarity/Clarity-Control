import type { EditorData } from '../../stores/data';
import type { PendingTooltip } from '../review/model';
import { queueView } from '../review/queueModel';
import { editorPath } from './editorPath';
import type { QueueItem } from './model';
import { reviewStamp, type ReviewRestore } from './sources';

/** A Review change as a queue item; its detail is the saved version it was taken in at. */
export function reviewItem(entry: PendingTooltip, data: EditorData): QueueItem {
  const hash = entry.tooltip.hash;
  return {
    key: String(hash),
    hash,
    name: entry.name,
    path: editorPath(hash, data),
    detail: reviewStamp(data.bundle.tooltips[hash] ?? entry.tooltip, data.aliases),
  };
}

/** The rows the Review list shows with these filters and groups, in its order. */
export function reviewRows(
  entries: PendingTooltip[],
  data: EditorData,
  restore: Pick<ReviewRestore, 'query' | 'category' | 'collapsed' | 'markerOpen'>,
): QueueItem[] {
  const view = queueView(
    entries,
    restore.query,
    restore.category,
    new Set(restore.collapsed),
    restore.markerOpen,
  );
  return view.ordered
    .filter(({ tooltip }) => view.shown.has(tooltip.hash))
    .map((entry) => reviewItem(entry, data));
}
