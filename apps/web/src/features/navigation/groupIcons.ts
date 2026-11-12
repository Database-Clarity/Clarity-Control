import type { Item } from '../../services/generator';
import { exoticArmourCategory, type GroupedSection } from './catalog';
import armour from './exotic-armor-icons.json';
import weapons from './exotic-weapon-icons.json';

/**
 * A group's icon in the finder's group list: an exotic weapon's own icon (the group id is the
 * weapon's hash), from exotic-weapon-icons.json. Other groupings (activities, artifacts) have
 * none, and a weapon missing from the file shows an empty box, never another item's icon.
 */
export function groupIcon(grouped: GroupedSection, id: string): string | undefined {
  if (grouped.grouping !== 'weapon') return undefined;
  const file = (weapons.icons as Record<string, string | undefined>)[id];
  return file ? `${weapons.source.prefix}${file}` : undefined;
}

/**
 * An Exotic Armor row's icon: the armour piece's own icon (exotic-armor-icons.json) when the
 * perk's owners are one piece (every owner hash carries the same name; two definitions of one
 * piece share their icon). A perk on several pieces (Aeon Safe/Soul/Swift) or with no owners in
 * the data keeps its own perk icon. A single piece missing from the file returns '' (an empty
 * box), never another item's icon. Every other category returns undefined: the row's own icon.
 */
export function exoticArmourRowIcon(item: Item): string | undefined {
  if (item.categoryId !== exoticArmourCategory) return undefined;
  const owners = item.owners ?? [];
  if (!owners.length) return item.icon;
  const names = new Set(owners.map((owner) => item.ownerNames?.[owner]?.trim() || String(owner)));
  if (names.size > 1) return item.icon;
  const files = armour.icons as Record<string, string | undefined>;
  const owner = [...owners].sort((a, b) => a - b).find((hash) => files[hash]);
  return owner === undefined ? '' : `${armour.source.prefix}${files[owner]}`;
}
