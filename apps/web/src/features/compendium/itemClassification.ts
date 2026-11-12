import type { Tooltip } from '@clarity/core';
import type { Item, Category } from '../../services/generator';
import { loadManifestFacts, type ManifestFacts } from './manifestFacts';
import triage from './owner-triage.json';
import { approvedExoticStat } from './ownerExceptions';
import { categoryDisplay } from '../../services/categoryLabels';

export function isSetSelector(
  item: Pick<Item, 'name' | 'hiddenFromEditor' | 'inGameDescription'>,
): boolean {
  return (
    item.hiddenFromEditor === true ||
    (/^Set Bonus:/.test(item.name) &&
      /^Converts this armor to the .+ armor set,/.test(item.inGameDescription))
  );
}

export const attachmentCategory = 'weapon-attachment';
export const effectCategory = 'attachment-effect';
export const inactiveCategory = 'inactive-placeholder';
/** Armour mods whose manifest plug only changes armour stats; listed apart from Armor Mods. */
export const armorStatCategory = 'armor-mod-stat';
const armorModCategory = 'armor-mod-general';
export const derivedCategories: Category[] = [
  attachmentCategory,
  effectCategory,
  inactiveCategory,
  armorStatCategory,
].map((id) => ({ id, ...categoryDisplay(id) }));
export interface ItemClassification {
  categoryId: string;
  ruleId: string;
  reason: string;
  excluded: boolean;
  origin: 'owner' | 'manifest' | 'editor';
  priority?: 'required' | 'tentative' | 'optional';
}
const facts = loadManifestFacts();
const members = new Map(triage.members.map((record) => [record.hash, record]));
const legacy = new Map(triage.legacyNoEquivalent.map((record) => [record.hash, record.name]));
const attachments = new Set([
  'barrels',
  'batteries',
  'magazines',
  'magazines_gl',
  'arrows',
  'bowstrings',
  'hafts',
  'tubes',
  'rails',
  'scopes',
  'grips',
  'stocks',
  'blades',
  'guards',
  // Crossbow bolts: the last parts left in Weapon Parts, grouped with the other parts.
  'bolts',
]);
const playerStats = new Set([2996146975, 392767087, 1735777505, 144602215, 1943323491, 4244567218]);
/**
 * Behaviour beyond stats in a part's manifest description (bullet stat lines ignored): damage,
 * a firing mode, detonation, chaining, blinding, bouncing, Overcharge, ability energy, or damage
 * resistance. Flavour lead-ins ("Agile sight. Short zoom.") and stat wording never match.
 */
const effectWording =
  /\b(?:damage|fires? (?:a|an|one|two|three|single)\b|burst|detonat\w*|chains? to|blinds?|bounces?|overcharge|ability energy)\b/i;
export function describesEffect(description: string): boolean {
  return effectWording.test(
    description
      .split('\n')
      .filter((line) => !/^\s*•/.test(line))
      .join(' '),
  );
}
/** Whether a tooltip has saved or drafted text in any language. */
export function hasAuthoredText(tooltip: Pick<Tooltip, 'text'>): boolean {
  return Object.values(tooltip.text).some((entry) => !!entry?.text.trim());
}
/** Exotic weapon entries (frames, perks, catalysts, parts): listed under their weapon. */
const exoticWeaponEntry = /^weapon-(?:frame|trait|catalyst|perk)-exotic$/;
export function triageMember(item: Pick<Item, 'hash' | 'name' | 'categoryId'>) {
  const record = members.get(item.hash);
  return record?.name === item.name && record.categoryId === `catalog:${item.categoryId}`
    ? record
    : undefined;
}
function classification(
  categoryId: string,
  ruleId: string,
  reason: string,
  excluded = true,
  origin: ItemClassification['origin'] = 'manifest',
  priority?: ItemClassification['priority'],
): ItemClassification {
  return { categoryId, ruleId, reason, excluded, origin, priority };
}
/** Where a stat-only armour mod is listed: apart from Armor Mods, other categories unchanged. */
function armorStatListing(item: Pick<Item, 'categoryId'>): string {
  return item.categoryId === armorModCategory ? armorStatCategory : item.categoryId;
}
/** The manifest plug category and description of an item, for presentation-only grouping. */
export function manifestPlug(hash: number): { plug: string | undefined; description: string } {
  const inventory = facts.items[hash]?.inventory;
  return {
    plug: inventory?.plug?.plugCategoryIdentifier || undefined,
    description: inventory?.description ?? '',
  };
}
/**
 * The current artifacts whose sockets offer this perk: socket memberships only (the socketed
 * artifact is `ownerHash`), one per artifact, in manifest order. Empty for perks of earlier
 * artifact definitions. Presentation-only grouping, like manifestPlug.
 */
export function manifestArtifacts(hash: number): { hash: number; name: string }[] {
  const seen = new Map<number, string>();
  for (const membership of facts.items[hash]?.artifactMemberships ?? []) {
    if (membership.source !== 'socket' || seen.has(membership.ownerHash)) continue;
    seen.set(membership.ownerHash, membership.artifactName?.trim() || String(membership.ownerHash));
  }
  return [...seen].map(([owner, name]) => ({ hash: owner, name }));
}
export function inferItemClassification(
  item: Item,
  fact: ManifestFacts['items'][string] | undefined,
): ItemClassification | undefined {
  const inv = fact?.inventory;
  if (
    !inv ||
    inv.redacted !== false ||
    inv.displayName !== item.name ||
    (item.inGameDescription.trim() && inv.description !== item.inGameDescription)
  )
    return;
  const plug = inv.plug?.plugCategoryIdentifier ?? '',
    description = inv.description ?? '';
  const stats = inv.investmentStats ?? [];
  if (plug === 'deprecated')
    return classification(
      inactiveCategory,
      'inactive-placeholder',
      'Manifest plug is deprecated; retained and viewable, not archived.',
    );
  if (
    /^enhancements\.v2_/.test(plug) &&
    inv.perks?.length === 0 &&
    stats.length === 0 &&
    /^(?:This mod will become available for use when the requirements for unlocking it are met\.|Access the Artifact Details screen to unlock additional passive Seasonal bonuses for your Guardian\.)$/.test(
      description,
    )
  )
    return classification(
      inactiveCategory,
      'inactive-placeholder',
      'Manifest identifies a locked, nonfunctional mod placeholder; data retained.',
    );
  if (
    plug.endsWith('.item_sets.selectors') &&
    /^Converts this armor to the .+ armor set,/.test(description)
  )
    return classification(
      item.categoryId,
      'irrelevant-selector',
      'Set-conversion selector, not an actual set bonus.',
    );
  if (
    plug === 'crafting.plugs.weapons.mods.extractors' &&
    /^Obtain Weapon Pattern progress/.test(description)
  )
    return classification(
      item.categoryId,
      'irrelevant-extractor',
      'Crafting extraction action, not a tooltip effect.',
    );
  if (
    (plug === 'enhancements.v2_general' ||
      plug === 'core.gear_systems.armor_tiering.plugs.tuning.mods') &&
    stats.some((s) => playerStats.has(s.statTypeHash) && s.value !== 0) &&
    stats.every((s) => playerStats.has(s.statTypeHash) || s.statTypeHash === 3578062600)
  )
    return classification(
      armorStatListing(item),
      'manifest-armor-stat',
      'Manifest stat/tuning plug modifies armour stats only.',
    );
  if (item.categoryId === 'weapon-perk' && attachments.has(plug) && inv.itemType === 19) {
    const pureStats =
      inv.perks?.length === 0 &&
      stats.some((s) => s.value !== 0) &&
      stats.every((s) => !s.isConditionallyActive) &&
      !describesEffect(description);
    return pureStats
      ? classification(
          attachmentCategory,
          'weapon-attachment',
          `Manifest ${plug}: unconditional investment stats, no effect perks; excluded by default.`,
        )
      : classification(
          effectCategory,
          'attachment-evidence-needed',
          `Manifest ${plug} has effect perks, effect wording, conditional or insufficient stat evidence; do not infer stat-only exclusion.`,
          false,
          'manifest',
          'required',
        );
  }
}
/** Enhanced weapon parts are edited with their base and never need a tooltip of their own (owner 2026-11-09). */
export const enhancedPartCategory = 'weapon-perk-enhanced';
export function classifyItem(item: Item, tooltip?: Tooltip): ItemClassification | undefined {
  if (item.categoryId === enhancedPartCategory)
    return classification(
      enhancedPartCategory,
      'enhanced-part',
      'Enhanced weapon part: edited with its base; no tooltip of its own needed.',
    );
  if (legacy.get(item.hash) === item.name) return;
  const record =
    triageMember(item) ??
    [item.baseHash, item.enhancedHash, ...(item.enhancedHashes ?? [])]
      .map((hash) => (hash === undefined ? undefined : members.get(hash)))
      .find(
        (candidate) =>
          candidate?.name === item.name &&
          candidate.categoryId === `catalog:${item.categoryId}` &&
          ['effect', 'effect-tentative'].includes(candidate.disposition),
      );
  let result = inferItemClassification(item, facts.items[item.hash]);
  if (approvedExoticStat(item, `catalog:${item.categoryId}`))
    result =
      (tooltip && hasAuthoredText(tooltip)) ||
      describesEffect(facts.items[item.hash]?.inventory?.description ?? '')
        ? classification(
            effectCategory,
            'exotic-part-no-weapon-row',
            'Exotic part with tooltip or effect text: weapon row is not its text; review its own source.',
            false,
            'owner',
            'required',
          )
        : classification(
            attachmentCategory,
            'manifest-weapon-stat',
            'Exotic part: weapon row is not its text; no tooltip needed unless promoted by an editor.',
            true,
            'owner',
          );

  if (record) {
    const d = record.disposition;
    const recordedExclusion = [
      'attachment',
      'inactive',
      'armor-stat',
      'weapon-mod-excluded',
      'irrelevant',
    ].includes(d);
    const inv = facts.items[item.hash]?.inventory;
    if (
      recordedExclusion &&
      (!inv ||
        inv.displayName !== item.name ||
        inv.plug?.plugCategoryIdentifier !== record.plugCategory ||
        inv.description !== record.manifestDescription ||
        (item.inGameDescription.trim() && item.inGameDescription !== inv.description))
    )
      return classification(
        d === 'attachment' ? effectCategory : item.categoryId,
        'owner-classification-evidence-changed',
        'Recorded owner classification no longer agrees with manifest identity, plug or description; confirm category/scope before matching.',
        false,
        'owner',
      );

    if (d === 'attachment')
      result = classification(
        attachmentCategory,
        record.ruleId,
        'Explicit owner triage: Stat-only Parts, excluded by default; may be promoted.',
        true,
        'owner',
      );
    if (d === 'effect' || d === 'effect-tentative')
      result = classification(
        effectCategory,
        record.ruleId,
        'Attachment source investigation unresolved; no approved standalone equivalent.' +
          (d === 'effect-tentative' ? ' Tooltip requirement is tentative.' : ' Tooltip required.'),
        false,
        'owner',
        d === 'effect-tentative' ? 'tentative' : 'required',
      );
    if (d === 'inactive')
      result = classification(
        inactiveCategory,
        record.ruleId,
        'Explicit owner triage: retain in Inactive & Placeholders; not archived.',
        true,
        'owner',
      );
    if (d === 'armor-stat')
      result = classification(
        armorStatListing(item),
        record.ruleId,
        'Explicit owner triage: stat-only armour/tuning mod.',
        true,
        'owner',
      );
    if (d === 'weapon-mod-excluded')
      result = classification(
        'weapon-mod',
        record.ruleId,
        'Explicit owner triage: heat/vent upgrade is a Weapon Mods entry; no tooltip needed.',
        true,
        'owner',
      );
    if (d === 'irrelevant')
      result = classification(
        item.categoryId,
        record.ruleId,
        'Explicit owner triage: selector/crafting action is irrelevant to matching.',
        true,
        'owner',
      );
    if (d === 'optional')
      result = classification(
        item.categoryId,
        record.ruleId,
        'Movement tooltip optional; historical investigation unresolved (sampled absence is not proof of no prior text).',
        false,
        'owner',
        'optional',
      );
    if (d === 'distinct-artifact')
      result = classification(
        item.categoryId,
        record.ruleId,
        'Elemental Siphon versions are distinct mechanics; artifact/plug identities unresolved. Never merge by name.',
        false,
        'owner',
        'required',
      );
  }
  // A manifest rule never lists an item with tooltip text as stat-only (owner 2026-11-11).
  if (
    result?.ruleId === attachmentCategory &&
    result.origin === 'manifest' &&
    tooltip &&
    hasAuthoredText(tooltip)
  )
    result = classification(
      effectCategory,
      'attachment-saved-text',
      'Tooltip text already exists; a manifest rule never lists it as stat-only.',
      false,
      'manifest',
      'required',
    );
  if (
    tooltip?.custom?.categoryId === attachmentCategory &&
    result &&
    [attachmentCategory, effectCategory].includes(result.categoryId)
  )
    return classification(
      attachmentCategory,
      'editor-attachment-override',
      'Editor-moved to Stat-only Parts: no tooltip required; owner/manifest classification is overridden only by this draft/saved category.',
      true,
      'editor',
    );
  if (
    tooltip?.custom?.categoryId === effectCategory &&
    result &&
    [attachmentCategory, effectCategory].includes(result.categoryId)
  )
    return classification(
      effectCategory,
      'editor-attachment-effect',
      'Editor-promoted Parts with Effects: requires a tooltip; normal source identity validation still applies.',
      false,
      'editor',
      'required',
    );
  if (tooltip?.custom?.categoryId === armorModCategory && result?.categoryId === armorStatCategory)
    // An editor move back to Armor Mods changes the listing only; the matching scope stays.
    return { ...result, categoryId: armorModCategory };
  return result;
}
/**
 * The finder category of a classified item. Exotic weapon entries always list under their weapon
 * in Exotic Weapons, never in Stat-only Parts or Parts with Effects: their classification still
 * decides tooltip scope (no tooltip / needs tooltip), only the listing stays with the weapon.
 */
export function listingCategoryId(
  item: Pick<Item, 'categoryId'>,
  classified: Pick<ItemClassification, 'categoryId'> | undefined,
): string {
  if (!classified) return item.categoryId;
  return exoticWeaponEntry.test(item.categoryId) &&
    (classified.categoryId === attachmentCategory || classified.categoryId === effectCategory)
    ? item.categoryId
    : classified.categoryId;
}
export function categoryLabel(id: string) {
  return derivedCategories.find((category) => category.id === id)?.label;
}
