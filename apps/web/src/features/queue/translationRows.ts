import type { EditorData } from '../../stores/data';
import { canonicalHash } from '../navigation/catalog';
import { queueFor, translationIndex, type QueueRow } from '../translations/queue';
import { entryPath } from '../translations/worklist';
import type { QueueItem } from './model';
import type { TranslationDetail, TranslationsRestore } from './sources';

/** A Translations row as a queue item: an override opens on its base's page, as the row does. */
export function translationItem(row: QueueRow, data: EditorData): QueueItem {
  return {
    key: row.key,
    hash: row.hash,
    lang: row.language,
    name: row.name,
    detail: { path: entryPath(row, canonicalHash(row.hash, data)) } satisfies TranslationDetail,
  };
}

/** The rows one Translations view lists now, in its order (Rebuild queue). */
export function translationRows(
  data: EditorData,
  view: Pick<TranslationsRestore, 'language' | 'state' | 'category' | 'query'>,
): QueueItem[] {
  return queueFor(translationIndex(data), view.language, view).map((row) =>
    translationItem(row, data),
  );
}
