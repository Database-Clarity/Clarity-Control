import { languages, usesEnglishFallback, type Lang } from '@clarity/core';
import type { Change } from '../api';
import { noImpactApplies, stampRevisions } from './enrichers/metadata';

/** Per changed tooltip, the languages whose live text after this save is the English text. */
export type LiveFallback = Record<number, Lang[]>;

/**
 * EXPORT-FALLBACK-VALIDATION: per changed tooltip, every language whose LIVE output after this
 * save is the English text. Live output exports a translation more than 90 days of English
 * revisions behind as the English text (core `usesEnglishFallback`), decided here on the tooltip
 * stamped exactly as the save will stamp it (same `now` and tick), so a new English revision that
 * flips a language, an English edit to a language that already falls back, and a save that keeps
 * the stamps (metadata, markup-only edits) are all covered. Save validation checks the live form.
 * Pure and cheap (no catalogue reads): run per save on the main thread to key the validation.
 */
export function liveFallback(
  changes: readonly Change[],
  now: string,
  noTranslationImpact: boolean,
): LiveFallback {
  const result: LiveFallback = {};
  for (const { hash, base, next } of changes) {
    // Only a translation with a source revision can fall back (usesEnglishFallback). A stamped
    // entry is the base's (unchanged text) or the draft's restamped to the new English (gap 0),
    // so without such an entry on either side nothing can fall back: skip the stamping work.
    if (
      !languages.some(
        (lang) =>
          lang !== 'en' &&
          (base?.text[lang]?.sourceUpdatedAt !== undefined ||
            next.text[lang]?.sourceUpdatedAt !== undefined),
      )
    )
      continue;
    let stamped;
    try {
      stamped = stampRevisions(base ?? undefined, next, '', now, noTranslationImpact);
    } catch {
      continue; // A translation without English: validation refuses the save anyway.
    }
    const live = languages.filter((lang) => usesEnglishFallback(stamped, lang));
    if (live.length) result[hash] = live;
  }
  return result;
}

/** Whether the "No translation impact" tick would change anything in this save. */
export function noImpactAvailable(changes: readonly Change[]): boolean {
  return changes.some(({ base, next }) => noImpactApplies(base ?? undefined, next));
}
