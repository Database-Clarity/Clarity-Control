import { resolveAlias, type Aliases } from '@clarity/core';
import type { EditorData } from '../../stores/data';

export function groupManifestItems(items: EditorData['items'], aliases: Aliases) {
  const groups = new Map<number, EditorData['items'][number][]>();
  for (const item of Object.values(items)) {
    const hash = resolveAlias(item.hash, aliases);
    groups.set(hash, [...(groups.get(hash) ?? []), item]);
  }
  return groups;
}
