import type { ReviewSample } from './reviewCategories';
import type { GuidanceReference } from './guidanceSchema';

const stat =
  '(?:range|stability|handling speed|reload speed|magazine size|aim assistance|recoil direction|airborne effectiveness|inventory size|charge time|draw time|blast radius|velocity|swing speed|guard resistance|guard efficiency|guard endurance|ammo reserves)';
const statLine = new RegExp(
  `^(?:(?:Slightly|Moderately|Greatly) )?(?:increases|decreases) ${stat}\\.?$`,
  'i',
);
// Exact, audited descriptive lead-ins. Unknown text must remain for owner review;
// a stat bullet never proves that an unrelated first sentence is harmless.
const statLeadIns = new Set([
  'High stiffness for quick handling.', 'Sturdy iron sights.',
  'Agile, snappy scope. Short zoom.', 'Powerful scope. Long zoom.',
  'This weapon can fire longer distances.', 'Durable yet light bowstring.',
  'Reduces weight for faster reloads.', 'Light sniper scope. Short zoom.',
  'Long-distance Häkke scope. Long zoom.', 'Combat sniper scope. Short zoom.',
  'Heavy, high capacity drum.', 'Balanced shotgun barrel.',
  'Omolon post sight. Short zoom.', 'Light and stable shaft material.',
  'Snapshot sight. Short zoom.', 'Lightweight sniper sight. Medium zoom.',
  'Stable Sidearm sight.', 'Sharp Hand Cannon sight.', 'Vicious scope. Long zoom.',
  'Light flexible sight. Medium zoom.', 'Far scope. Long zoom.',
  'Lightweight sight. Short zoom.', 'Strong battery life.', 'Pinpoint Sidearm sight.',
  'Agile Hand Cannon sight.', 'Ultra-light barrel.', 'Focused scope. Long zoom.',
  'Barrel optimized for distance.', 'Agile post sights. Short zoom.',
  'Agile iron sights. Short zoom.', 'Durable ranged barrel.',
  'Accurate Hand Cannon sight.', 'Agile sight. Short zoom.', 'Large heavy battery.',
  'Rugged and simple iron sights. Short zoom.', 'Circular iron sights. Short zoom.',
  'Omolon Post sights. Short zoom.', 'Superior scope. Short zoom.',
  'Assault scope. Long zoom.', 'Häkke marksman scope. Long zoom.',
  'Lightweight, agile battery.', 'Balanced scope. Medium zoom.', 'Strong optics. Long zoom.',
  'Ocular sights. Long zoom.', 'Red-dot. Medium zoom.', 'Improves stability.',
  'Barrel optimized for recoil reduction.', 'Distance optimizations.',
  'Agile Sidearm sight.', 'Precision scope. Long zoom.', 'Accurized sight. Medium zoom.',
  'Ranged scope. Long zoom.', 'Ranged shotgun barrel.', 'Häkke holo sights. Medium zoom.',
  'Thin-lens scope. Short zoom.', 'Balanced Sidearm sight.',
  'SUROS projection sight. Short zoom.', 'Dual strength barrel.',
  'SUROS lightweight red-dot sight. Short zoom.', 'SUROS holo sights. Medium zoom.',
  'SUROS ranged combat scope. Long zoom.', 'Lightweight scope. Short zoom.',
  'Stable Hand Cannon sight.', 'Optimized for extended range.', 'Pinpoint Hand Cannon sight.',
  'Accurate Sidearm sight.', 'This weapon has multiple small improvements.',
  'Sharp Sidearm sight.', 'Omolon red-dot. Medium zoom.', 'Balanced Hand Cannon sight.',
  'Light, flexible sight. Short zoom.', 'Scrappy scope. Medium zoom.',
  'Balanced scope. Short zoom.',
]);
function pure(text: string, flavor = false): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  const bullets = lines.filter((line) => line.startsWith('•'));
  if (flavor && bullets.length && !lines[0].startsWith('•')) {
    if (!statLeadIns.has(lines[0])) return false;
    lines.shift();
  }
  return (
    lines.length > 0 &&
    (!flavor || lines.every((line) => line.startsWith('•'))) &&
    lines.every((line) => statLine.test(line.replace(/^•\s*/, '')))
  );
}

export function manifestRule(
  entry: ReviewSample,
  category: string,
  support: Map<number, GuidanceReference>,
) {
  const facts = entry.manifestFacts;
  const item = facts?.item;
  const inv = item?.inventory;
  if (!facts || !item || !inv || inv.redacted !== false) return undefined;
  const stats = inv.investmentStats ?? [];
  const unconditional =
    stats.length > 0 &&
    stats.some((s) => s.value !== 0) &&
    stats.every((s) => !s.isConditionallyActive);
  const description = inv.description ?? '';
  const weaponUsages = item.plugUsages.filter(
    (u) => u.ownerItemType === 3 && u.socketCategoryHash === 4241085061,
  );
  let ruleId = '';
  let hashes: number[] = [];
  if (
    category === 'catalog:weapon-perk' &&
    unconditional &&
    inv.perks?.length === 0 &&
    weaponUsages.length > 0 &&
    weaponUsages.every((u) => u.ordinal === 0 || u.ordinal === 1) &&
    pure(description, true)
  ) {
    ruleId = 'manifest-weapon-stat';
    hashes = [5699512, 935202422];
  } else if (
    category === 'catalog:armor-mod-general' &&
    unconditional &&
    inv.plug?.plugCategoryIdentifier === 'core.gear_systems.armor_tiering.plugs.tuning.mods' &&
    /^Increases this armor's Tuned stat at the cost of a small amount of the (Class|Grenade|Health|Melee|Super|Weapons) stat\.$/.test(
      description,
    )
  ) {
    ruleId = 'manifest-armor-stat';
    hashes = [309000506];
  } else if (
    /^Equip this weapon ornament to change the appearance/.test(description) &&
    inv.itemCategoryHashes?.includes(52) &&
    inv.itemCategoryHashes.includes(56)
  ) {
    ruleId = 'manifest-weapon-ornament';
    hashes = [91797877];
  } else if (
    (category.startsWith('catalog:armor-mod-') || category === 'catalog:weapon-mod') &&
    (/^This mod has been deprecated and no longer functions\./.test(description) ||
      inv.tooltipNotifications?.some(
        (n) =>
          typeof n.displayString === 'string' &&
          /has fizzled at the conclusion/.test(n.displayString),
      ))
  ) {
    ruleId = 'manifest-retired-mod';
    hashes = [1285109625];
  } else if (
    category === 'catalog:weapon-mod' &&
    stats.some((s) => s.value !== 0) &&
    inv.perks?.length === 1 &&
    inv.perks[0].perkHash === 1171737860 &&
    inv.perks[0].requirementDisplayString === 'Requires Adept Weapon' &&
    (!description.trim() || pure(description))
  ) {
    ruleId = 'manifest-adept-mod';
    hashes = [299264772];
  }
  const hash = hashes.find((h) => support.has(h));
  if (!hash) return undefined;
  return {
    action: 'no-equivalent' as const,
    confidence: 'high' as const,
    ruleId,
    references: [hash],
    reason: `${ruleId}; owner support ${hash}; manifest ${facts.version}; facts ${JSON.stringify({ inventory: inv, plugUsages: item.plugUsages })}`,
  };
}
