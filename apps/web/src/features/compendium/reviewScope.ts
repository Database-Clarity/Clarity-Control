import type { GuidanceReference } from './guidanceSchema';
import { artifactParents } from './artifactIdentity';
import { approvedExoticStat } from './ownerExceptions';
import { manifestRule } from './manifestRule';
import type { ReviewCategory, ReviewSample } from './reviewCategories';

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
    (entry.scopeRestored && !entry.artifactSunset && !approvedExoticStat(entry, category))
  )
    return undefined;
  if (entry.classification?.excluded) return entry.classification.ruleId;
  if (entry.classification?.categoryId === 'attachment-effect') return undefined;
  if (category === 'catalog:armor-mod-seasonal' && entry.artifactSunset)
    return artifactParents(entry).length ? 'artifact-sunset' : 'artifact-source-absent';
  if (approvedExoticStat(entry, category)) return 'manifest-weapon-stat';
  if (category === 'catalog:ghost-mod' && !config.includeGhostMods) return 'ghost-mod';
  const rule = manifestRule(entry, category, statSupport)?.ruleId;
  return rule === 'manifest-weapon-stat' || rule === 'manifest-armor-stat' ? rule : undefined;
}

export function inScopeCategory(category: ReviewCategory): ReviewCategory {
  const included = (entry: ReviewSample) => !classifyScope(entry, category.id);
  return {
    ...category,
    entries: category.entries.filter(included),
    samples: category.samples.filter(included),
    reasons: Object.fromEntries(
      Object.entries(category.reasons).map(([reason, entries]) => [
        reason,
        entries.filter(included),
      ]),
    ) as ReviewCategory['reasons'],
  };
}
