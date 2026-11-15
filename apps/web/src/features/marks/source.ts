import type { EditorData } from '../../stores/data';
import { navigationGroups } from '../navigation/catalog';
import { merged, type QueueItem } from '../queue/model';
import type { QueueSource } from '../queue/sources';
import { useMarksStore } from './store';
import { tooltipPath } from '../navigation/stepping';
import { markSearchMatches } from './finder';

export function markedQueueItems(
  data: EditorData,
  type: string,
  search = '',
  query = '',
): QueueItem[] {
  const { marks, index } = useMarksStore.getState();
  const matching = query.trim()
    ? new Set([
        ...markSearchMatches(index, query),
        ...navigationGroups(data, query).flatMap((group) =>
          group.sections.flatMap((section) => section.items.map((item) => item.hash)),
        ),
      ])
    : undefined;
  const items = new Map(
    navigationGroups(data, '').flatMap((group) =>
      group.sections.flatMap((section) => section.items.map((item) => [item.hash, item] as const)),
    ),
  );
  return Object.entries(marks.entries)
    .filter(
      ([hash, entries]) =>
        items.has(Number(hash)) &&
        (!matching || matching.has(Number(hash))) &&
        entries.some((entry) => entry.type === type),
    )
    .map(([hash]) => ({
      key: hash,
      hash: Number(hash),
      name: items.get(Number(hash))!.name,
      detail: type,
      path: tooltipPath(Number(hash), search, `mark.${type}`),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
}
export const marksQueue: QueueSource = {
  label: 'Marked entries',
  path: (item) => item.path ?? `/t/${item.hash}`,
  done: () => (item) =>
    !useMarksStore.getState().marks.entries[item.hash]?.some((mark) => mark.type === item.detail),
  async rebuild(queue, { data }) {
    const restore = queue.origin.restore as { type: string; search?: string; query?: string };
    return merged(queue, markedQueueItems(data, restore.type, restore.search, restore.query));
  },
};
