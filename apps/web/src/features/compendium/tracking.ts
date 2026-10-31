import { resolveCompendiumLink, type CompendiumData, type Tooltip } from '@clarity/core';

export function compendiumChanges(tooltips: Record<string, Tooltip>, data: CompendiumData) {
  return Object.values(tooltips)
    .flatMap((tooltip) => {
      if (!tooltip.compendium) return [];
      const resolution = resolveCompendiumLink(tooltip.compendium, data);
      return resolution.status === 'ok' ? [] : [{ tooltip, resolution }];
    })
    .sort(
      (a, b) =>
        b.tooltip.compendium!.snapshotAt.localeCompare(a.tooltip.compendium!.snapshotAt) ||
        a.tooltip.hash - b.tooltip.hash,
    );
}
