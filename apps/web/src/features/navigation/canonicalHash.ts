import { aliasPairedBase, resolveAlias, type Aliases, type AliasItems } from '@clarity/core';

export interface NavigationGroups {
  aliases: Aliases;
  items: AliasItems;
  bundle: { aliasGroups?: unknown };
}

const canonicalIndexes = new WeakMap<NavigationGroups, Map<number, number>>();
export function canonicalHash(hash: number, data: NavigationGroups): number {
  let index = canonicalIndexes.get(data);
  if (!index) canonicalIndexes.set(data, (index = new Map()));
  const cached = index.get(hash);
  if (cached !== undefined) return cached;
  const seen = new Set<number>();
  const remember = (canonical: number) => {
    for (const member of seen) index.set(member, canonical);
    return canonical;
  };
  while (!seen.has(hash)) {
    seen.add(hash);
    const resolved = resolveAlias(hash, data.aliases);
    if (resolved !== hash) {
      hash = resolved;
      continue;
    }
    const item = data.items[hash];
    // A grouped frame owns one editor even if manifest pairing points elsewhere.
    if (frameGroupSize(hash, data) > 1) return remember(hash);
    const target =
      item?.baseHash ??
      (data.bundle.aliasGroups ? aliasPairedBase(item, data.items, data.aliases) : undefined);
    if (target === undefined) return remember(hash);
    hash = target;
  }
  throw new Error(`Cyclic tooltip alias at ${hash}`);
}

const frameCounts = new WeakMap<NavigationGroups, Map<number, number>>();
export function frameGroupSize(hash: number, data: NavigationGroups): number {
  let counts = frameCounts.get(data);
  if (!counts) {
    counts = new Map();
    for (const [alias, entry] of Object.entries(data.aliases)) {
      if (entry.kind !== 'frame') continue;
      const target = resolveAlias(Number(alias), data.aliases);
      counts.set(target, (counts.get(target) ?? 1) + 1);
    }
    frameCounts.set(data, counts);
  }
  return counts.get(hash) ?? 1;
}
