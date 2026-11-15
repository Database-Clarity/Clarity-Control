import type { EditorData } from '../../stores/data';
import { recordKey, visibleRecords, type LostText } from '../lost-text/model';
import type { QueueItem } from './model';
import type { LostRestore } from './sources';

/** Lost text's rows as queue items, apart from the other lists' so its page loads only these. */

export function lostItem(record: LostText, data: EditorData): QueueItem {
  return {
    key: recordKey(record),
    hash: record.hash,
    lang: record.lang,
    name: data.items[record.hash]?.name ?? record.name,
    detail: record,
  };
}

export function lostRows(
  records: LostText[],
  data: EditorData,
  decisions: Record<string, string>,
  filters: Pick<LostRestore, 'query' | 'classFilter' | 'showDismissed'>,
): LostText[] {
  return visibleRecords(
    records,
    data.bundle.tooltips,
    decisions,
    filters.classFilter !== '',
    filters.classFilter === 'all' ? '' : filters.classFilter,
    filters.showDismissed,
  ).filter((r) => `${r.name} ${r.hash}`.toLowerCase().includes(filters.query.trim().toLowerCase()));
}
