import { stableStringify, type AliasGroups, type AliasItems, type Aliases } from '@clarity/core';

export const globalUsagesFile = 'global-usages.json';

/** Canonical hash inputs shared by the publisher and browser. Keep the item fields used by
 * canonicalHash and aliasPairedBase, including membership by record key. */
export function globalUsageStampInputs(
  items: AliasItems,
  aliases: Aliases,
  groups: AliasGroups | undefined,
) {
  return {
    items: JSON.stringify(
      Object.keys(items)
        .sort()
        .map((key) => {
          const { hash, baseHash, name, categoryId, isEnhanced, exotic, plugCategoryHash } =
            items[key];
          return { key, hash, baseHash, name, categoryId, isEnhanced, exotic, plugCategoryHash };
        }),
    ),
    aliases: stableStringify({ aliases, groups: groups?.groups ?? null }),
  };
}
