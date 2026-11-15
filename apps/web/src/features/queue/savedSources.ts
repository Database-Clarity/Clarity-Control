import { resolveAlias } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { editorDraftIndex } from '../../services/editorDrafts';
import { canonicalHash, editorName, itemFor } from '../navigation/catalog';
import { editorPath } from './editorPath';
import type { QueueItem } from './model';
import { reviewStamp } from './model';
import type { WorklistEntry } from '../../../../../packages/core/src/worklists';

export function worklistAvailable(hash: number, data: EditorData): boolean {
  try {
    canonicalHash(hash, data); // Reject cyclic identities, while allowing enhanced override paths.
    return (
      resolveAlias(hash, data.aliases) === hash &&
      !data.bundle.tooltips[hash]?.archive &&
      !!itemFor(hash, data)
    );
  } catch {
    return false;
  }
}
export function savedItems(items: WorklistEntry[], data: EditorData): QueueItem[] {
  return items.map((item) => ({
    ...item,
    name:
      item.name ||
      (itemFor(item.hash, data) ? editorName(itemFor(item.hash, data)!) : String(item.hash)),
    key: String(item.hash),
    path: editorPathSafe(item.hash, data),
    detail: reviewStamp(data.bundle.tooltips[item.hash], data.aliases),
  }));
}
function editorPathSafe(hash: number, data: EditorData) {
  try {
    return editorPath(hash, data);
  } catch {
    return `/t/${hash}`;
  }
}
export async function draftItems(data: EditorData): Promise<QueueItem[]> {
  const hashes = await editorDraftIndex();
  return savedItems(
    [...hashes]
      .filter(
        (hash) =>
          worklistAvailable(hash, data) && !data.bundle.tooltips[hash]?.text.en?.text.trim(),
      )
      .map((hash) => ({
        hash,
        name: editorName(itemFor(hash, data)!),
      })),
    data,
  );
}
