import type { Item } from '../../services/generator';
import { exoticWeaponsCategory, finderCategoryId } from '../navigation/catalog';
import weapons from '../navigation/exotic-weapon-icons.json';

/** Generator ownership only; repeated definitions of one weapon share one header icon. */
export function weaponOwners(item: Item | undefined) {
  if (!item || finderCategoryId(item.categoryId) !== exoticWeaponsCategory) return undefined;
  const files = weapons.icons as Record<string, string | undefined>;
  const distinct = new Map<string, { hash: number; name: string; icon: string }>();
  for (const hash of item.owners ?? (item.itemHash === undefined ? [] : [item.itemHash])) {
    const name =
      item.ownerNames?.[hash]?.trim() ||
      (hash === item.itemHash ? item.itemName?.trim() : undefined) ||
      String(hash);
    const icon = files[hash] ? `${weapons.source.prefix}${files[hash]}` : '';
    if (!distinct.has(name) || (!distinct.get(name)!.icon && icon)) {
      distinct.set(name, { hash, name, icon });
    }
  }
  return [...distinct.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function weaponOwnerLabel(owners: NonNullable<ReturnType<typeof weaponOwners>>) {
  const names = owners.map((owner) => owner.name).join(', ');
  return owners.length > 1 ? `Shared perk · ${names}` : names;
}
