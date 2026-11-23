import {
  resolveCompendiumLink,
  withCompendiumMatchingIndex,
  type CompendiumData,
  type CompendiumResolution,
  type Tooltip,
} from '@clarity/core';

/** The linked text changed or the link needs relinking; a moved row with the same text does not. */
export function sourceNeedsUpdate(resolution: CompendiumResolution): boolean {
  return !('row' in resolution) || resolution.changed;
}

const cache = new WeakMap<
  Record<string, Tooltip>,
  { data: CompendiumData; changes: ReturnType<typeof findChanges> }
>();
/** Every saved link whose source is not as it was saved; kept per data set for all its readers. */
export function compendiumChanges(tooltips: Record<string, Tooltip>, data: CompendiumData) {
  const cached = cache.get(tooltips);
  if (cached?.data === data) return cached.changes;
  const changes = withCompendiumMatchingIndex(data, () => findChanges(tooltips, data));
  cache.set(tooltips, { data, changes });
  return changes;
}

function findChanges(tooltips: Record<string, Tooltip>, data: CompendiumData) {
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
