import { resolveAlias, type Aliases } from '@clarity/core';
import type { EditorData } from '../../stores/data';

const cached = new WeakMap<
  EditorData['items'],
  WeakMap<Aliases, Map<number, EditorData['items'][number][]>>
>();

export function groupManifestItems(items: EditorData['items'], aliases: Aliases) {
  let byAliases = cached.get(items);
  if (!byAliases) cached.set(items, (byAliases = new WeakMap()));
  const previous = byAliases.get(aliases);
  if (previous) return previous;
  const groups = new Map<number, EditorData['items'][number][]>();
  for (const item of Object.values(items)) {
    const hash = resolveAlias(item.hash, aliases);
    const group = groups.get(hash);
    if (group) group.push(item);
    else groups.set(hash, [item]);
  }
  byAliases.set(aliases, groups);
  return groups;
}
