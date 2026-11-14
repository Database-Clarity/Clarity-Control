import type { Lang } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { canonicalHash } from '../navigation/catalog';
import type { QueueItem, QueueSourceId } from './model';

/**
 * Where a tooltip opens in the editor: its canonical page, with `variant=` naming an enhanced
 * override or alias (the editor redirects a bare override hash to its base and loses the variant).
 */
export function editorPath(hash: number, data: EditorData, lang?: Lang): string {
  const canonical = canonicalHash(hash, data);
  const query = [
    ...(lang ? [`lang=${lang}`] : []),
    ...(canonical === hash ? [] : [`variant=${hash}`]),
  ];
  return `/t/${canonical}${query.length ? `?${query.join('&')}` : ''}`;
}

/**
 * The items with where each opens, for the sources that open a tooltip's editor page. Done when a
 * queue starts or is rebuilt, never per list render (Lost text lists hundreds of rows).
 */
export function withEditorPaths(
  source: QueueSourceId,
  items: QueueItem[],
  data: EditorData,
): QueueItem[] {
  if (source !== 'drift' && source !== 'lost-text' && source !== 'review') return items;
  return items.map((item) => ({
    ...item,
    path: editorPath(item.hash, data, source === 'lost-text' ? item.lang : undefined),
  }));
}
