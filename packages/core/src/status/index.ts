import { resolveAlias, type Aliases } from '../aliases.js';
import { translationMaxAge } from '../exportLegacy.js';
import { languages, type Lang } from '../languages.js';
import type { Tooltip } from '../schemas.js';

export interface DriftEntry {
  tooltip: Tooltip;
  description: string;
}

export function bungieDrift(
  tooltips: readonly Tooltip[],
  items: Readonly<Record<string, { inGameDescription: string }>>,
  aliases: Aliases = {},
): { changed: DriftEntry[]; missingSnapshots: number } {
  const changed: DriftEntry[] = [];
  let missingSnapshots = 0;
  for (const tooltip of tooltips) {
    if (resolveAlias(tooltip.hash, aliases) !== tooltip.hash) continue;
    const item = items[tooltip.hash];
    if (!item) continue;
    if (!tooltip.bungieSnapshot) missingSnapshots++;
    else if (tooltip.bungieSnapshot.description !== item.inGameDescription) {
      changed.push({ tooltip, description: item.inGameDescription });
    }
  }
  changed.sort((a, b) => a.tooltip.hash - b.tooltip.hash);
  return { changed, missingSnapshots };
}

export interface OutdatedTranslation {
  tooltip: Tooltip;
  language: Lang;
  sourceUpdatedAt: string;
  ageMs: number;
  exportedInEnglish: boolean;
}

export function outdatedTranslations(
  tooltips: readonly Tooltip[],
  selectedLanguages: readonly Lang[] = languages,
  aliases: Aliases = {},
): OutdatedTranslation[] {
  const selected = new Set(selectedLanguages);
  const entries: OutdatedTranslation[] = [];
  for (const tooltip of tooltips) {
    if (resolveAlias(tooltip.hash, aliases) !== tooltip.hash || !tooltip.text.en) continue;
    for (const language of languages) {
      if (language === 'en' || !selected.has(language)) continue;
      const sourceUpdatedAt = tooltip.text[language]?.sourceUpdatedAt;
      if (!sourceUpdatedAt) continue;
      const ageMs = Date.parse(tooltip.text.en.updatedAt) - Date.parse(sourceUpdatedAt);
      if (ageMs > 0) {
        entries.push({
          tooltip,
          language,
          sourceUpdatedAt,
          ageMs,
          exportedInEnglish: ageMs > translationMaxAge,
        });
      }
    }
  }
  return entries.sort(
    (a, b) =>
      b.ageMs - a.ageMs || a.tooltip.hash - b.tooltip.hash || a.language.localeCompare(b.language),
  );
}

export type TranslationState = 'missing' | 'outdated' | 'current';

export interface TranslationQueueEntry {
  tooltip: Tooltip;
  language: Lang;
  state: TranslationState;
  /** Only for `outdated`: English revision gap in ms (> 0). */
  ageMs?: number;
  /** Only for `outdated`: the English revision the translation was based on. */
  sourceUpdatedAt?: string;
  /** Only for `outdated`: the gap exceeds the export limit, so English is exported instead. */
  exportedInEnglish?: boolean;
}

const stateRank: Record<TranslationState, number> = { outdated: 0, missing: 1, current: 2 };

/**
 * Every tooltip × selected non-English language with its translation state.
 * `missing` = English exists but there is no saved translation; `outdated` matches
 * `outdatedTranslations`; everything else (including translations without a known source
 * revision) is `current`. Aliases and tooltips without English are never listed.
 * Order: outdated (largest gap first), then missing, then current; ties by hash, language.
 */
export function translationQueue(
  tooltips: readonly Tooltip[],
  selectedLanguages: readonly Lang[] = languages,
  aliases: Aliases = {},
): TranslationQueueEntry[] {
  const selected = new Set(selectedLanguages);
  const entries: TranslationQueueEntry[] = [];
  for (const tooltip of tooltips) {
    const english = tooltip.text.en;
    if (resolveAlias(tooltip.hash, aliases) !== tooltip.hash || !english) continue;
    for (const language of languages) {
      if (language === 'en' || !selected.has(language)) continue;
      const translation = tooltip.text[language];
      if (!translation) {
        entries.push({ tooltip, language, state: 'missing' });
        continue;
      }
      const sourceUpdatedAt = translation.sourceUpdatedAt;
      const ageMs = sourceUpdatedAt
        ? Date.parse(english.updatedAt) - Date.parse(sourceUpdatedAt)
        : 0;
      if (sourceUpdatedAt && ageMs > 0) {
        entries.push({
          tooltip,
          language,
          state: 'outdated',
          ageMs,
          sourceUpdatedAt,
          exportedInEnglish: ageMs > translationMaxAge,
        });
      } else entries.push({ tooltip, language, state: 'current' });
    }
  }
  return entries.sort(
    (a, b) =>
      stateRank[a.state] - stateRank[b.state] ||
      (b.ageMs ?? 0) - (a.ageMs ?? 0) ||
      a.tooltip.hash - b.tooltip.hash ||
      a.language.localeCompare(b.language),
  );
}

export interface ArchiveItem {
  categoryId: string;
  baseHash?: number;
  enhancedHash?: number;
  enhancedHashes?: number[];
}

/** Pure detection only: absence never writes archival metadata. */
export function removedFromManifest(
  tooltips: readonly Tooltip[],
  items: Readonly<Record<string, ArchiveItem>> | null | undefined,
  aliases: Aliases = {},
  inactiveHashes: ReadonlySet<number> = new Set(),
): { paused: boolean; removed: Tooltip[]; returned: Tooltip[] } {
  if (!items || !Object.keys(items).length) return { paused: true, removed: [], returned: [] };
  const presentMembers = new Set<number>();
  for (const [hash, item] of Object.entries(items)) {
    presentMembers.add(resolveAlias(Number(hash), aliases));
    for (const member of [item.baseHash, item.enhancedHash, ...(item.enhancedHashes ?? [])]) {
      if (member !== undefined) presentMembers.add(member);
    }
  }
  const tracked = tooltips.filter(
    (tooltip) =>
      tooltip.hash > 3 &&
      !tooltip.custom &&
      !inactiveHashes.has(tooltip.hash) &&
      items[tooltip.hash]?.categoryId !== 'inactive-placeholder' &&
      tooltip.archive?.lastSeen.categoryId !== 'inactive-placeholder',
  );
  const missing = tracked.filter(
    (tooltip) =>
      !items[tooltip.hash] &&
      !presentMembers.has(tooltip.hash) &&
      !presentMembers.has(resolveAlias(tooltip.hash, aliases)),
  );
  // Previously confirmed removals are not a new simultaneous disappearance.
  const newlyMissing = missing.filter((tooltip) => !tooltip.archive);
  if (newlyMissing.length > tracked.length * 0.05)
    return { paused: true, removed: [], returned: [] };
  return {
    paused: false,
    removed: missing,
    returned: tracked.filter((tooltip) => tooltip.archive && items[tooltip.hash]),
  };
}
