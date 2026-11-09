import type { Category } from './generatorSchema';

/**
 * How the editor names, groups, and orders the generator's categories (owner-approved 2026-11-04).
 * Labels only: category ids, legacy types, and export are unchanged. The generator still ships its
 * older labels; they are overridden here when the catalog loads, so every list reads one registry.
 *
 * Rules: always plural, modifier before the noun, "Perks" for the trait column, "Parts" for
 * barrels/magazines/scopes/stocks; family order base, Enhanced, Exotic; families in the order
 * Perks, Origin Traits, Frames, Catalysts, Mods, Parts. Group order: Weapons, Armor, Ghost,
 * Subclasses, Other.
 */
export const categoryGroups = ['Weapons', 'Armor', 'Ghost', 'Subclasses', 'Other'] as const;
export type CategoryGroupName = (typeof categoryGroups)[number];

interface CategorySpec {
  label: string;
  group: CategoryGroupName;
  order: number;
  /** The label the generator and earlier editor builds used; still finds the category in searches. */
  was?: string;
}
const spec = (
  group: CategoryGroupName,
  order: number,
  label: string,
  was?: string,
): CategorySpec => ({ group, order, label, was });

export const categorySpecs: Readonly<Record<string, CategorySpec>> = {
  'weapon-trait': spec('Weapons', 100, 'Weapon Perks', 'Weapon Trait'),
  'weapon-trait-enhanced': spec('Weapons', 101, 'Enhanced Weapon Perks', 'Weapon Trait Enhanced'),
  'weapon-trait-exotic': spec('Weapons', 102, 'Exotic Weapon Perks', 'Weapon Trait Exotic'),
  'weapon-trait-enhanced-exotic': spec(
    'Weapons',
    103,
    'Enhanced Exotic Weapon Perks',
    'Weapon Trait Enhanced Exotic',
  ),
  'weapon-trait-origin': spec('Weapons', 110, 'Origin Traits', 'Weapon Trait Origin'),
  'weapon-trait-origin-enhanced': spec(
    'Weapons',
    111,
    'Enhanced Origin Traits',
    'Weapon Trait Origin Enhanced',
  ),
  'weapon-trait-origin-exotic': spec(
    'Weapons',
    112,
    'Exotic Origin Traits',
    'Weapon Trait Origin Exotic',
  ),
  'weapon-trait-origin-enhanced-exotic': spec(
    'Weapons',
    113,
    'Enhanced Exotic Origin Traits',
    'Weapon Trait Origin Enhanced Exotic',
  ),
  'weapon-frame': spec('Weapons', 120, 'Weapon Frames', 'Weapon Frame'),
  'weapon-frame-enhanced': spec('Weapons', 121, 'Enhanced Frames', 'Weapon Frame Enhanced'),
  'weapon-frame-exotic': spec('Weapons', 122, 'Exotic Frames', 'Weapon Frame Exotic'),
  'weapon-frame-enhanced-exotic': spec(
    'Weapons',
    123,
    'Enhanced Exotic Frames',
    'Weapon Frame Enhanced Exotic',
  ),
  'weapon-catalyst-exotic': spec('Weapons', 130, 'Exotic Catalysts', 'Weapon Catalyst Exotic'),
  'weapon-mod': spec('Weapons', 140, 'Weapon Mods', 'Weapon Mod'),
  'weapon-mod-enhanced': spec('Weapons', 141, 'Enhanced Weapon Mods', 'Weapon Mod Enhanced'),
  'weapon-mod-enhanced-exotic': spec(
    'Weapons',
    143,
    'Enhanced Exotic Weapon Mods',
    'Weapon Mod Enhanced Exotic',
  ),
  'weapon-perk': spec('Weapons', 150, 'Weapon Parts', 'Weapon Perk'),
  'weapon-perk-enhanced': spec('Weapons', 151, 'Enhanced Weapon Parts', 'Weapon Perk Enhanced'),
  'weapon-perk-exotic': spec('Weapons', 152, 'Exotic Weapon Parts', 'Weapon Perk Exotic'),
  'weapon-perk-enhanced-exotic': spec(
    'Weapons',
    153,
    'Enhanced Exotic Weapon Parts',
    'Weapon Perk Enhanced Exotic',
  ),
  // Editor-derived (see itemClassification): parts split by whether they carry an effect.
  'weapon-attachment': spec('Weapons', 154, 'Stat-only Parts', 'Weapon Attachments'),
  'attachment-effect': spec('Weapons', 155, 'Parts with Effects', 'Attachment Effects'),

  'armor-trait-exotic': spec('Armor', 200, 'Exotic Armor Perks', 'Armor Trait Exotic'),
  'armor-mod-general': spec('Armor', 220, 'Armor Mods', 'Armor Mod General'),
  // Editor-derived (see itemClassification): armour mods that only change armour stats.
  'armor-mod-stat': spec('Armor', 221, 'Stat-only Armor Mods', 'Armor Stat Mods'),
  'armor-set-bonus': spec('Armor', 210, 'Armor Set Bonuses'),
  'armor-mod-combat': spec('Armor', 230, 'Combat Mods', 'Armor Mod Combat'),
  'armor-mod-activity': spec('Armor', 240, 'Activity Mods', 'Armor Mod Activity'),
  'armor-mod-seasonal': spec('Armor', 250, 'Artifact Perks', 'Armor Mod Seasonal'),

  'ghost-mod': spec('Ghost', 300, 'Ghost Mods', 'Ghost Mod'),

  'subclass-fragment': spec('Subclasses', 400, 'Fragments', 'Subclass Fragment'),
  'subclass-aspect': spec('Subclasses', 410, 'Aspects', 'Subclass Aspect'),
  'subclass-super': spec('Subclasses', 420, 'Supers', 'Subclass Super'),
  'subclass-grenade': spec('Subclasses', 430, 'Grenades', 'Subclass Grenade'),
  'subclass-melee': spec('Subclasses', 440, 'Melee Abilities', 'Subclass Melee'),
  'subclass-class': spec('Subclasses', 450, 'Class Abilities', 'Subclass Class'),
  'subclass-movement': spec('Subclasses', 460, 'Movement Abilities', 'Subclass Movement'),
  verbs: spec('Subclasses', 470, 'Keywords', 'Subclass Verbs and Keywords'),

  'inactive-placeholder': spec(
    'Other',
    9998,
    'Inactive & Placeholders',
    'Inactive & Placeholder Items',
  ),
};

/** Fallback for a category id the registry does not know: a visible warning, never a silent label. */
export const unknownCategoryLabel = (id: string) => `Other: ${id}`;

export function categoryDisplay(id: string): Pick<Category, 'label' | 'group' | 'order'> {
  const known = categorySpecs[id];
  return known
    ? { label: known.label, group: known.group, order: known.order }
    : { label: unknownCategoryLabel(id), group: 'Other', order: 9999 };
}

/** The category as the editor shows it: generator id and legacy type kept, presentation replaced. */
export function presentCategory<T extends Category>(category: T): T {
  return { ...category, ...categoryDisplay(category.id) };
}

/** All categories, presented and in the editor's group and category order (not the generator's). */
export function presentCategories<T extends Category>(categories: readonly T[]): T[] {
  return categories
    .map(presentCategory)
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.order - b.order);
}

/** Earlier name of a category, so searches typed from habit still find it. */
export function previousCategoryLabel(id: string): string {
  return categorySpecs[id]?.was ?? '';
}

export function groupRank(group: string): number {
  const rank = (categoryGroups as readonly string[]).indexOf(group);
  return rank < 0 ? categoryGroups.length : rank;
}

const populated = new WeakMap<object, Set<string>>();
/**
 * Categories that have at least one item; an empty category (Combat Mods, the Enhanced Exotic
 * families) is hidden from every picker and dropdown rather than offered as a dead end.
 */
export function nonEmptyCategories<T extends { id: string }>(data: {
  categories: readonly T[];
  items: Record<string, { categoryId: string }>;
}): T[] {
  let ids = populated.get(data.items);
  if (!ids) {
    ids = new Set<string>();
    for (const item of Object.values(data.items)) ids.add(item.categoryId);
    populated.set(data.items, ids);
  }
  const used = ids;
  return data.categories.filter((category) => used.has(category.id));
}
