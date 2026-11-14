import type { UpcomingRow, UpcomingFilters } from '../translations/upcoming';
import type { EditorData } from '../../stores/data';
import { canonicalHash } from '../navigation/catalog';
import { tooltipPath } from '../navigation/stepping';
import { startQueue } from './start';
import type { QueueItem } from './model';

export function upcomingItem(row: UpcomingRow, data: EditorData): QueueItem {
  const canonical = canonicalHash(row.hash, data);
  const query = new URLSearchParams({ lang: row.language });
  if (canonical !== row.hash) query.set('variant', String(row.hash));
  return {
    key: row.key,
    hash: row.hash,
    lang: row.language,
    name: row.name,
    detail: { path: tooltipPath(canonical, query.toString()), batchId: row.batchId },
  };
}
export function startUpcomingQueue(
  first: UpcomingRow,
  rows: readonly UpcomingRow[],
  data: EditorData,
  origin: string,
  filters: UpcomingFilters,
  top: number,
  id?: string,
) {
  const originURL = new URL(origin, 'https://editor.invalid');
  originURL.searchParams.set('upcoming', '1');
  return startQueue({
    id,
    source: 'translations',
    scope: 'shown',
    destination: { kind: 'batch', batchId: first.batchId, batchName: first.batchName },
    items: rows
      .filter((row) => row.batchId === first.batchId)
      .map((row) => upcomingItem(row, data)),
    first: upcomingItem(first, data),
    origin: {
      path: `${originURL.pathname}${originURL.search}`,
      restore: {
        language: first.language,
        state: null,
        upcomingState: filters.state,
        category: filters.category,
        query: filters.query,
        top,
        selectedRow: first.key,
        summary: `${first.batchName} · Upcoming`,
      },
    },
  });
}
