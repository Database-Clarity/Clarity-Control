import { languages } from '../languages.js';
import type { Tooltip } from '../schemas.js';

/**
 * Composing different English with a translation of a later revision must not show it current.
 * Mark only those future sources just outdated; preserve real age gaps and the 90-day fallback.
 * This applies to batch composition and resolution, never ordinary saves.
 */
export function boundTranslationSources(tooltip: Tooltip): Tooltip {
  if (!tooltip.text.en) return tooltip;
  const englishAt = Date.parse(tooltip.text.en.updatedAt);
  const text = { ...tooltip.text };
  for (const lang of languages) {
    const entry = text[lang];
    if (lang !== 'en' && entry?.sourceUpdatedAt && Date.parse(entry.sourceUpdatedAt) > englishAt)
      text[lang] = { ...entry, sourceUpdatedAt: new Date(englishAt - 1).toISOString() };
  }
  return { ...tooltip, text };
}
