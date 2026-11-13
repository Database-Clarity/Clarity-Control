import type { Item } from '../../services/generator';
import { exoticArmourCategory, exoticPiece, type GroupedSection } from './catalog';
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
 * An Exotic Armor perk's piece icon (exotic-armor-icons.json) when the perk's owners are one piece
 * (every owner hash carries the same name; two definitions of one piece share their icon). A perk
 * on several pieces (Aeon Safe/Soul/Swift), with no owners in the data, or outside Exotic Armor
 * returns undefined. A single piece missing from the file returns '' (an empty box), never another
 * item's icon.
 */
export function exoticPieceIcon(item: Item): string | undefined {
  if (item.categoryId !== exoticArmourCategory) return undefined;
  const owners = item.owners ?? [];
  if (!owners.length) return undefined;
  const names = new Set(owners.map((owner) => item.ownerNames?.[owner]?.trim() || String(owner)));
  if (names.size > 1) return undefined;
  const files = armour.icons as Record<string, string | undefined>;
  const owner = [...owners].sort((a, b) => a - b).find((hash) => files[hash]);
  return owner === undefined ? '' : `${armour.source.prefix}${files[owner]}`;
}

/**
 * The preview header's piece icon, beside the piece row: only when that row names a piece (a perk
 * named after its piece has an empty row and no piece icon).
 */
export function previewPieceIcon(item: Item): string | undefined {
  return exoticPiece(item) ? exoticPieceIcon(item) : undefined;
}

/**
 * An Exotic Armor row's icon: the piece's icon (exoticPieceIcon) when the perk belongs to one
 * piece, else the perk's own icon. Every other category returns undefined: the row's own icon.
 */
export function exoticArmourRowIcon(item: Item): string | undefined {
  if (item.categoryId !== exoticArmourCategory) return undefined;
  return exoticPieceIcon(item) ?? item.icon;
}
