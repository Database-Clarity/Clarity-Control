import type { GuidanceReference } from './guidanceSchema';
import { manifestRule } from './manifestRule';
import type { ReviewSample } from './reviewCategories';

export const scopeConfig = { includeGhostMods: false };

const statSupport = new Map(
  [5699512, 935202422, 309000506].map((hash) => [hash, {} as GuidanceReference]),
);

export function classifyScope(
  entry: ReviewSample,
  category: string,
  config: { includeGhostMods: boolean } = scopeConfig,
): string | undefined {
  if (
    entry.base.compendium ||
    entry.next.compendium ||
    entry.status !== 'open' ||
    entry.scopeRestored
  )
    return undefined;
  if (category === 'catalog:ghost-mod' && !config.includeGhostMods) return 'ghost-mod';
  const rule = manifestRule(entry, category, statSupport)?.ruleId;
  return rule === 'manifest-weapon-stat' || rule === 'manifest-armor-stat' ? rule : undefined;
}
