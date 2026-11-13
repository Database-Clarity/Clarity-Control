import { baseEnhancedPublishMessage } from './markup/baseEnhanced.js';
import { lowerElementTags } from './markup/elementTags.js';
import { languages } from './languages.js';
import type { LegacyCatalog, LegacyFacts, LegacyMetadata, LegacyPerk } from './legacy.js';
import { isTextlessDescription, tooltipSchema, type Tooltip } from './schemas.js';
import { resolveAlias, type Aliases } from './aliases.js';
import { validateTextWithReads } from './validation/index.js';

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
    english.text.trim() !== '' &&
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
  aliasKind: 'sandbox' | 'frame' | 'name';
};
export type LegacyExportEntry = LegacyEntry | LegacyAliasStub;

export function isLegacyAliasStub(entry: LegacyExportEntry): entry is LegacyAliasStub {
  return 'aliasOf' in entry;
}

/**
 * The live perks after an export: exported entries replace their keys, and a sandbox alias stub
 * that points at an exported tooltip but is not exported again (its pick was withdrawn, undone,
 * moved to another tooltip, or the perk stopped being shared) is removed. Every other live record
 * stays exactly as it is. With no withdrawn stub this is `{ ...live, ...entries }`.
 */
export function mergeLivePerks(
  live: Readonly<Record<string, unknown>>,
  entries: Readonly<Record<string, LegacyExportEntry>>,
): Record<string, unknown> {
  const exported = new Set<number>();
  for (const entry of Object.values(entries))
    if (!isLegacyAliasStub(entry)) exported.add(entry.hash);
  const merged: Record<string, unknown> = { ...live, ...entries };
  for (const [key, value] of Object.entries(live)) {
    if (Object.hasOwn(entries, key) || typeof value !== 'object' || value === null) continue;
    const stub = value as { aliasOf?: unknown; aliasKind?: unknown };
    if (
      stub.aliasKind === 'sandbox' &&
      typeof stub.aliasOf === 'number' &&
      exported.has(stub.aliasOf)
    )
      delete merged[key];
  }
  return merged;
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
  const omitted = new Set<number>();
  for (const input of tooltips) {
    const tooltip = tooltipSchema.parse(input);
    // Reserved global libraries are required converter inputs, even when a library is empty.
    if (isTextlessDescription(tooltip)) {
      omitted.add(tooltip.hash);
      continue;
    }
    // Last consumer boundary: native markup is stored, but cannot reach the old converter.
    if (Object.values(tooltip.text).some((translation) => translation?.text.includes('{{'))) {
      throw new Error(baseEnhancedPublishMessage);
    }
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
      // Element-tagged text (`<solar Scorch />`) leaves the editor in today's format
      // (`<solar/>Scorch`): every consumer reads exactly what authors wrote before tags existed.
      const text = lowerElementTags(exported.text);
      editor[language] = { main: text, secondary: text };
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
  // Check the real resolver's reads, including nested imports and global title bodies.
  // Never silently turn an import of an omitted record into a dangling consumer reference.
  if (omitted.size) {
    for (const language of languages) {
      const imports = Object.fromEntries(
        Object.entries(canonical).map(([hash, entry]) => [
          hash,
          entry.editor[language]?.main ?? '',
        ]),
      );
      for (const alias of Object.keys(aliases)) {
        const target = resolveAlias(Number(alias), aliases);
        if (canonical[target]) imports[alias] = imports[target] ?? '';
      }
      for (const entry of Object.values(canonical)) {
        if (entry.associated?.some((hash) => omitted.has(hash)))
          throw new Error(`Tooltip ${entry.hash} associates an empty tooltip`);
        const text = entry.editor[language]?.main;
        if (text === undefined) continue;
        const { reads } = validateTextWithReads(
          text,
          language,
          {
            imports,
            variables: imports[2] ?? '',
            titles: imports[3] ?? '',
          },
          false,
          entry.hash,
          aliases,
        );
        for (const hash of reads.imports.values()) {
          if (omitted.has(hash))
            throw new Error(`Tooltip ${entry.hash} imports empty tooltip ${hash}`);
        }
      }
    }
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
