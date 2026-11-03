import { languages } from './languages.js';
import type { LegacyCatalog, LegacyFacts, LegacyMetadata, LegacyPerk } from './legacy.js';
import { tooltipSchema, type Tooltip } from './schemas.js';
import { resolveAlias, type Aliases } from './aliases.js';

function exportFacts(facts: LegacyFacts | undefined): Partial<LegacyFacts> {
  if (!facts) return {};
  return {
    name: facts.name,
    type: facts.type,
    ...(facts.itemHash === undefined ? {} : { itemHash: facts.itemHash }),
    ...(facts.itemName === undefined ? {} : { itemName: facts.itemName }),
  };
}

export const translationMaxAge = 90 * 24 * 60 * 60 * 1000;
/** Whether a translation is exported as the English text instead of its own (stale-translation fallback). */
export function usesEnglishFallback(tooltip: Tooltip, language: keyof Tooltip['text']): boolean {
  const english = tooltip.text.en;
  const translation = tooltip.text[language];
  return Boolean(
    language !== 'en' &&
    english &&
    translation &&
    translation.sourceUpdatedAt !== undefined &&
    Date.parse(english.updatedAt) - Date.parse(translation.sourceUpdatedAt) > translationMaxAge,
  );
}
export type LegacyEntry = LegacyMetadata &
  Pick<LegacyPerk, 'hash' | 'editor'> &
  Partial<Pick<LegacyPerk, 'name' | 'type' | 'itemHash' | 'itemName'>> & {
    associated?: number[];
  };
/** An alias references its canonical tooltip; it carries only its own catalog facts, if any. */
export type LegacyAliasStub = Partial<LegacyFacts> & {
  hash: number;
  aliasOf: number;
  aliasKind: 'sandbox' | 'frame';
};
export type LegacyExportEntry = LegacyEntry | LegacyAliasStub;

export function isLegacyAliasStub(entry: LegacyExportEntry): entry is LegacyAliasStub {
  return 'aliasOf' in entry;
}

export function exportLegacy(
  tooltips: readonly Tooltip[],
  now: number,
  catalog?: LegacyCatalog,
  aliases: Aliases = {},
): Record<string, LegacyExportEntry> {
  if (!Number.isFinite(now) || now < 0 || !Number.isInteger(now)) {
    throw new TypeError('now must be nonnegative integer epoch milliseconds');
  }
  const entries: Record<string, LegacyExportEntry> = {};
  const canonical: Record<string, LegacyEntry> = {};
  for (const input of tooltips) {
    const tooltip = tooltipSchema.parse(input);
    if (resolveAlias(tooltip.hash, aliases) !== tooltip.hash) {
      throw new Error(`Alias ${tooltip.hash} cannot have its own tooltip`);
    }
    if (canonical[tooltip.hash]) throw new Error(`Duplicate tooltip hash: ${tooltip.hash}`);
    const english = tooltip.text.en;
    const editor: LegacyEntry['editor'] = {};
    const descriptions: NonNullable<LegacyEntry['updateTracker']>['descriptions'] = {
      ...tooltip.legacy?.updateTracker?.descriptions,
    };
    for (const language of languages) {
      const translation = tooltip.text[language];
      if (!translation) continue;
      const exported = usesEnglishFallback(tooltip, language) && english ? english : translation;
      editor[language] = { main: exported.text, secondary: exported.text };
      const old = tooltip.legacy?.updateTracker?.descriptions[language];
      descriptions[language] = {
        lastUpdate: Date.parse(exported.updatedAt),
        ...(exported.updatedBy !== '' || old?.updatedBy !== undefined
          ? { updatedBy: exported.updatedBy }
          : {}),
      };
    }
    const facts =
      catalog?.[tooltip.hash] ??
      (tooltip.custom ? { name: tooltip.custom.name, type: tooltip.custom.categoryId } : undefined);
    if (catalog && !facts) throw new Error(`Missing manifest facts for tooltip ${tooltip.hash}`);
    const associated = [
      ...new Set(tooltip.associated.map((hash) => resolveAlias(hash, aliases))),
    ].filter((hash) => hash !== tooltip.hash);
    canonical[tooltip.hash] = entries[tooltip.hash] = {
      ...tooltip.legacy,
      ...exportFacts(facts),
      hash: tooltip.hash,
      ...(associated.length ? { associated } : {}),
      editor,
      uploadedBy: tooltip.legacy?.uploadedBy ?? '',
      lastUpload: tooltip.legacy?.lastUpload ?? now,
      inLiveDatabase: tooltip.legacy?.inLiveDatabase ?? false,
      uploadToLive: tooltip.legacy?.uploadToLive ?? false,
      updateTracker: { ...tooltip.legacy?.updateTracker, descriptions },
    };
  }
  for (const [alias, { kind }] of Object.entries(aliases)) {
    const target = resolveAlias(Number(alias), aliases);
    if (!canonical[target]) continue;
    const facts = catalog?.[alias];
    if (catalog && kind === 'frame' && !facts) {
      throw new Error(`Missing manifest facts for frame alias ${alias}`);
    }
    entries[alias] = {
      hash: Number(alias),
      aliasOf: target,
      aliasKind: kind,
      ...exportFacts(facts),
    };
  }
  return entries;
}
