import type { GroupedSection } from './catalog';
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
