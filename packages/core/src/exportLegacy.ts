import { baseEnhancedPublishMessage } from './markup/baseEnhanced.js';
import { lowerConsumerMarkup } from './markup/braces.js';
import { languages } from './languages.js';
import type { LegacyCatalog, LegacyFacts, LegacyMetadata, LegacyPerk } from './legacy.js';
import { isTextlessDescription, tooltipSchema, type Tooltip } from './schemas.js';
import { resolveAlias, type Aliases } from './aliases.js';
import type { AliasGroups } from './aliasGroups.js';
import { validateTextWithReads } from './validation/index.js';
import { numberTokens, numberValues, resolveNumberTokens } from './numbers/map.js';
import { validateNumberTooltip } from './validation/numbers.js';

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
    ((translation.sourceUpdatedAt !== undefined &&
      Date.parse(english.updatedAt) - Date.parse(translation.sourceUpdatedAt) >
        translationMaxAge) ||
      (translation.text.includes('#{=') &&
        numberTokens(translation.text).some((token) => {
          const retired = token.id === undefined ? undefined : english.numbers?.retired[token.id];
          return (
            retired === null || (typeof retired === 'object' && retired.fallback.includes(language))
          );
        }))),
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

/** The stub exportLegacy writes for alias `alias` (facts from the catalog; frames require them). */
function aliasStub(
  alias: string,
  aliases: Aliases,
  catalog: LegacyCatalog | undefined,
): LegacyAliasStub | undefined {
  const entry = aliases[alias];
  if (!entry) return undefined;
  const facts = catalog?.[alias];
  if (catalog && (entry.kind === 'frame' || entry.kind === 'name') && !facts) {
    throw new Error(`Missing manifest facts for ${entry.kind} alias ${alias}`);
  }
  return {
    hash: Number(alias),
    aliasOf: resolveAlias(Number(alias), aliases),
    aliasKind: entry.kind,
    ...exportFacts(facts),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Until its own first publish, a member a maintainer removed from an alias group keeps its live
 * stub, and stubs that resolve through it keep reading its former canonical: unrelated publishes
 * never leave a window without its text (root 2026-11-23). Only a removed member whose live row is
 * still its name stub qualifies, and mergeLivePerks writes no stub without a live target record.
 */
function withUnpublishedRemovals(
  aliases: Aliases,
  removed: AliasGroups['removed'],
  live: Readonly<Record<string, unknown>>,
  entries: Readonly<Record<string, LegacyExportEntry>>,
  catalog: LegacyCatalog | undefined,
): Aliases {
  const view: Aliases = { ...aliases };
  for (const [hash, { canonical }] of Object.entries(removed ?? {})) {
    const row = live[hash];
    if (!isRecord(row) || row.aliasKind !== 'name') continue;
    if (Object.hasOwn(entries, hash) || Object.hasOwn(aliases, hash)) continue;
    // Never block a publish over a retained stub: no manifest facts, or a pointer back to itself.
    if ((catalog && !catalog[hash]) || resolveAlias(canonical, view) === Number(hash)) continue;
    view[hash] = { to: canonical, kind: 'name' };
  }
  return view;
}

/**
 * The live perks after an export (root 2026-11-13): exported entries replace their keys, and every
 * key the sandbox picks file names (`picks`: picks, "no tooltip", and undone tombstones) is
 * RECOMPUTED from `aliases` (the generator's plus the picks, core mergeSandboxPointers): the pick's
 * stub if picked, else the generator's own stub for that key if it has one, else absent. A stub is
 * written only while its target is a live canonical record (as exportLegacy writes stubs only for
 * exported tooltips); a key that holds its own tooltip record is never touched. Keys the file does
 * not name are untouched, so without a picks file this is `{ ...live, ...entries }`, v2's bytes.
 */
export function mergeLivePerks(
  live: Readonly<Record<string, unknown>>,
  entries: Readonly<Record<string, LegacyExportEntry>>,
  picks?: { keys: Iterable<string>; aliases: Aliases; catalog?: LegacyCatalog },
  groups?: { aliases: Aliases; catalog: LegacyCatalog },
  /** The alias group config's removed members (see withUnpublishedRemovals). */
  removed?: AliasGroups['removed'],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...live, ...entries };
  if (removed) {
    const keep = <T extends { aliases: Aliases; catalog?: LegacyCatalog }>(view: T): T => ({
      ...view,
      aliases: withUnpublishedRemovals(view.aliases, removed, live, entries, view.catalog),
    });
    picks &&= keep(picks);
    groups &&= keep(groups);
  }
  for (const key of picks?.keys ?? []) {
    if (Object.hasOwn(entries, key)) continue;
    const current = merged[key];
    if (isRecord(current) && !('aliasOf' in current)) continue;
    const stub = aliasStub(key, picks!.aliases, picks!.catalog);
    const target = stub && merged[String(stub.aliasOf)];
    if (stub && isRecord(target) && !('aliasOf' in target)) merged[key] = stub;
    else delete merged[key];
  }
  // Only an explicit group snapshot enables name reconciliation. Ungroup leaves an empty
  // config, so former name stubs disappear until a reviewed export restores their own text.
  // Never restore archived/draft text, or flatten an obsolete stub into an authored record.
  if (groups) {
    const keys = new Set([
      ...Object.keys(live).filter((key) => {
        const entry = live[key];
        return (
          isRecord(entry) &&
          'aliasOf' in entry &&
          (entry.aliasKind === 'name' ||
            (groups.aliases[key] && resolveAlias(Number(key), groups.aliases) !== entry.aliasOf))
        );
      }),
      ...Object.keys(groups.aliases).filter((key) => groups.aliases[key]?.kind === 'name'),
    ]);
    for (const key of keys) {
      if (Object.hasOwn(entries, key)) continue;
      const stub = aliasStub(key, groups.aliases, groups.catalog);
      const target = stub && merged[String(stub.aliasOf)];
      if (stub && isRecord(target) && !('aliasOf' in target)) merged[key] = stub;
      else {
        const current = merged[key];
        if (groups.aliases[key]?.kind === 'name' && isRecord(current) && !('aliasOf' in current))
          throw new Error(`Publish canonical ${stub?.aliasOf} before grouping live tooltip ${key}`);
        delete merged[key];
      }
    }
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
    const numberIssue = validateNumberTooltip(tooltip)[0];
    if (numberIssue)
      throw new Error(`Tooltip ${tooltip.hash} (${numberIssue.lang}): ${numberIssue.message}`);
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
      const englishFallback = usesEnglishFallback(tooltip, language);
      const exported = englishFallback && english ? english : translation;
      // Element-tagged text (`<solar Scorch />`), delimited variables (`#{d}`), and the arrow
      // symbol (`<enhanced/>`) leave the editor in today's format (`<solar/>Scorch`, `#d`, `#e`):
      // every consumer reads exactly what authors wrote before those forms existed.
      const resolved =
        exported.text.includes('#{=') && english
          ? resolveNumberTokens(exported.text, numberValues(english, language))
          : exported.text;
      const text = lowerConsumerMarkup(resolved);
      editor[language] = {
        main: text,
        secondary: text,
        ...(englishFallback ? { englishFallback: true } : {}),
      };
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
  for (const alias of Object.keys(aliases)) {
    const target = resolveAlias(Number(alias), aliases);
    if (!canonical[target]) continue;
    entries[alias] = aliasStub(alias, aliases, catalog)!;
  }
  return entries;
}
