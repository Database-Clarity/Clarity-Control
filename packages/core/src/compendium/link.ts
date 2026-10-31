import { reviewedCompendiumLink, reviewedCompendiumRules } from './reviewed.js';
import { resolveAlias } from '../aliases.js';
import type { Aliases } from '../aliases.js';
import type { Tooltip } from '../schemas.js';
import {
  compendiumIdentifiers,
  compendiumNameVariants,
  compendiumPreferredTabs,
  isTrackedCompendiumTab,
} from './config.js';
import {
  compendiumSimilarity,
  combineCompendiumMatches,
  normaliseCompendiumName,
  resolveCompendiumLink,
  snapshotCompendium,
  type CompendiumCandidate,
  type CompendiumMatch,
} from './resolve.js';
import type { CompendiumData } from './types.js';

export interface CompendiumItem {
  hash: number;
  name: string;
  categoryId: string;
  itemName?: string;
  baseHash?: number;
}
export interface AutoLinkResult {
  hash: number;
  name: string;
  category: string;
  next?: Tooltip;
  reason: 'linked' | 'ambiguous' | 'unmatched' | 'no-equivalent' | 'alias';
  candidates: CompendiumCandidate[];
}
export function autoLinkCompendium(
  tooltip: Tooltip,
  items: Record<string, CompendiumItem>,
  aliases: Aliases,
  data: CompendiumData,
  now: string,
  tooltips: Record<string, Tooltip> = {},
): AutoLinkResult {
  const item = items[tooltip.hash];
  const name = item?.name ?? tooltip.custom?.name ?? String(tooltip.hash);
  const category = item?.categoryId ?? tooltip.custom?.categoryId ?? 'unknown';
  const result = { hash: tooltip.hash, name, category, candidates: [] };
  if (resolveAlias(tooltip.hash, aliases) !== tooltip.hash) return { ...result, reason: 'alias' };
  if (tooltip.hash <= 3) return { ...result, reason: 'no-equivalent' };
  if (tooltip.compendium) {
    const resolved = resolveCompendiumLink(tooltip.compendium, data);
    if ('row' in resolved) return { ...result, reason: 'linked' };
    return resolved.status === 'candidates'
      ? { ...result, reason: 'ambiguous', candidates: resolved.candidates }
      : { ...result, reason: 'unmatched' };
  }
  if (reviewedCompendiumRules[tooltip.hash]) {
    const compendium = reviewedCompendiumLink(tooltip, items, aliases, data, now, tooltips);
    return compendium
      ? { ...result, reason: 'linked', next: { ...tooltip, compendium } }
      : { ...result, reason: 'unmatched' };
  }
  const family = Object.values(items).filter(
    (entry) => resolveAlias(entry.hash, aliases) === tooltip.hash,
  );
  const base = item?.baseHash === undefined ? undefined : items[item.baseHash];
  const names = new Set(
    [
      ...compendiumNameVariants(category, name),
      item?.itemName,
      base?.name,
      base?.itemName,
      ...family.flatMap((entry) => [entry.name, entry.itemName]),
    ].filter((value): value is string => !!value),
  );
  const normalized = new Set([...names].map(normaliseCompendiumName));
  const all = data.tabs
    .filter((tab) => isTrackedCompendiumTab(tab.name))
    .flatMap((tab) => tab.rows.map((row) => ({ tab, row })));
  const preferred = compendiumPreferredTabs(category, name);
  function matches(rows: CompendiumMatch[]): CompendiumMatch[] {
    const direct = rows.filter(({ row }) =>
      compendiumIdentifiers(row.name).some((identifier) => identifier === name),
    );
    if (direct.length) return direct;
    const normalizedName = normaliseCompendiumName(name);
    const normalizedDirect = rows.filter(({ row }) =>
      compendiumIdentifiers(row.name).some(
        (identifier) => normaliseCompendiumName(identifier) === normalizedName,
      ),
    );
    if (normalizedDirect.length) return normalizedDirect;
    const exact = rows.filter(({ row }) =>
      compendiumIdentifiers(row.name).some((identifier) => names.has(identifier)),
    );
    return exact.length
      ? exact
      : rows.filter(({ row }) =>
          compendiumIdentifiers(row.name).some((identifier) =>
            normalized.has(normaliseCompendiumName(identifier)),
          ),
        );
  }
  let found: CompendiumMatch[] = [];
  for (const gid of preferred) {
    found = matches(all.filter(({ tab }) => tab.gid === gid));
    if (found.length) break;
  }
  if (!found.length) found = matches(all);
  if (
    found.length &&
    found.every(
      ({ tab, row }) => tab.gid === found[0].tab.gid && row.nameNorm === found[0].row.nameNorm,
    )
  ) {
    found = all.filter(
      ({ tab, row }) => tab.gid === found[0].tab.gid && row.nameNorm === found[0].row.nameNorm,
    );
  }
  const combined = combineCompendiumMatches(found);
  if (combined)
    return {
      ...result,
      reason: 'linked',
      next: { ...tooltip, compendium: snapshotCompendium(combined, now) },
    };
  const english = tooltip.text.en?.text ?? '';
  const candidates = (found.length ? found : all)
    .map((match) => ({ ...match, similarity: compendiumSimilarity(english, match.row.cell.plain) }))
    .filter((candidate) => found.length || candidate.similarity >= 0.6)
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.tab.gid.localeCompare(b.tab.gid) ||
        a.row.rowIndex - b.row.rowIndex,
    )
    .slice(0, 3);
  return {
    ...result,
    reason: found.length
      ? 'ambiguous'
      : category.startsWith('ghost-')
        ? 'no-equivalent'
        : 'unmatched',
    candidates,
  };
}
