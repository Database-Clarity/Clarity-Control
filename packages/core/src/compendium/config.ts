export interface CompendiumTabConfig {
  name: string;
  nameColumns?: number[];
  descriptionColumns?: number[];
  nameHeaders?: string[];
  descriptionHeaders?: string[];
  sectionHeaders?: string[];
  groups?: CompendiumColumns[];
  cards?: boolean;
  navigationOnly?: boolean;
  sectionOverrides?: Record<string, CompendiumColumns[]>;
  sectionCategories?: Record<string, string>;
}
export interface CompendiumColumns {
  nameColumns: number[];
  descriptionColumns: number[];
  section?: string;
}
export function isTrackedCompendiumTab(name: string): boolean {
  return !name.includes('OLD');
}
const glossary = {
  nameColumns: [1],
  descriptionColumns: [3],
  sectionHeaders: ['Glossary', 'Hunters', 'Titans', 'Warlocks'],
  nameHeaders: ['Fragments', 'Aspects'],
  descriptionHeaders: ['Information', 'Stat Changes', 'Fragment Slots'],
};
const armorSlots = [
  'Helmet',
  'Arms',
  'Chest',
  'Legs',
  'Class Item',
  'Raid-Specific',
  'Raid Specific',
  'Activity or Destination Specific',
  'Charged With Light',
  'Warmind Cells',
  'Elemental Wells',
  'Activity-Specific',
];
const artifactCards = (columns: number[], offset: number) =>
  columns.map((column) => ({
    nameColumns: [column],
    descriptionColumns: [column + offset],
  }));
// Columns are zero-based overrides only; recognized headers take precedence on every fetch.
export const compendiumTabs: Record<string, CompendiumTabConfig> = {
  '1038486120': { name: 'Landing', navigationOnly: true },
  '1662574278': {
    name: 'Weapon Perks',
    sectionCategories: {
      'Weapon Traits': 'trait',
      'Intrinsic Traits': 'frame',
      'Origin Traits': 'origin',
      'Enhanced Weapon Mods are equippable only on Tier 4 and Tier 5 Weapons.': 'mod',
      'Heavy Crossbow Information': 'frame',
      'Glaive Information': 'frame',
      'Sword Guard Information': 'frame',
    },
  },
  '1287885342': { name: 'Armor Perks' },
  '473308249': { name: 'Artifact Perks', cards: true, groups: artifactCards([2, 5, 8], -1) },
  '1934379638': { name: 'Armor Mods', nameHeaders: armorSlots },
  '618967225': { name: 'Arc', ...glossary },
  '1186062409': { name: 'Solar', ...glossary },
  '1907852650': { name: 'Void', ...glossary },
  '1088259962': { name: 'Stasis', ...glossary },
  '1870531554': { name: 'Strand', ...glossary },
  '1918152785': { name: 'Prismatic', ...glossary },
  '20898389': {
    name: 'Exotic Class',
    sectionHeaders: ['Class-agnostic Perks'],
    groups: [
      { nameColumns: [0], descriptionColumns: [2] },
      { nameColumns: [3], descriptionColumns: [5] },
    ],
  },
  '527596209': {
    name: 'Class Abilities',
    ...glossary,
    sectionHeaders: ['Hunters', 'Titans', 'Warlocks'],
  },
  '441434520': {
    name: 'Exotic Weapons',
    nameColumns: [0],
    descriptionColumns: [3],
    sectionHeaders: ['Kinetic Slot Weapons'],
  },
  '1500097863': { name: 'Exotic Armors', descriptionHeaders: ['Notes'] },
  '1800463143': { name: 'Game Mechanics', nameHeaders: ['Challenge Modifiers', 'Modifier'] },
  '715236319': {
    name: 'OLD Episodic Artifact Perks',
    cards: true,
    groups: artifactCards([2, 5, 8, 11, 14], -1),
  },
  '70425171': {
    name: 'OLD Seasonal Artifact Perks',
    cards: true,
    groups: artifactCards([1, 4, 7, 10, 13], 0),
  },
  '333521426': {
    name: 'OLD Nether Mechanics',
    sectionOverrides: {
      'Heresy Mods': [{ nameColumns: [2], descriptionColumns: [5] }],
      'Minor Boons': [{ nameColumns: [2], descriptionColumns: [3] }],
      'Major Boons': [{ nameColumns: [2], descriptionColumns: [3] }],
    },
  },
  '1925335732': { name: 'OLD Armor Mods', nameHeaders: armorSlots },
  '135237481': { name: 'OLD Game Mechanics', nameHeaders: ['Modifier'] },
  '2137280685': { name: 'OLD Exotic Armors', descriptionHeaders: ['Notes'] },
};

const subclasses = [
  '618967225',
  '1186062409',
  '1907852650',
  '1088259962',
  '1870531554',
  '1918152785',
];
export const compendiumCategoryTabs: Record<string, string[]> = {
  'weapon-perk': ['1662574278'],
  'weapon-perk-exotic': ['441434520', '1662574278'],
  'weapon-trait': ['1662574278'],
  'weapon-trait-enhanced': ['1662574278'],
  'weapon-trait-exotic': ['441434520'],
  'weapon-trait-enhanced-exotic': ['441434520'],
  'weapon-trait-origin': ['1662574278'],
  'weapon-trait-origin-exotic': ['1662574278'],
  'weapon-frame': ['1662574278'],
  'weapon-frame-enhanced': ['1662574278'],
  'weapon-frame-exotic': ['441434520'],
  'weapon-frame-enhanced-exotic': ['441434520'],
  'weapon-catalyst-exotic': ['441434520'],
  'weapon-mod': ['1662574278'],
  'armor-trait-exotic': ['1500097863', '20898389'],
  'armor-mod-general': ['1934379638', '1925335732'],
  'armor-mod-combat': ['1934379638', '1925335732'],
  'armor-mod-activity': ['1934379638', '1925335732'],
  'armor-mod-seasonal': ['473308249', '715236319', '70425171'],
  'subclass-fragment': subclasses,
  'subclass-aspect': subclasses,
  'subclass-super': subclasses,
  'subclass-grenade': subclasses,
  'subclass-melee': subclasses,
  'subclass-class': ['527596209', ...subclasses],
  'subclass-movement': subclasses,
  verbs: subclasses,
};

const fragmentTabs: Record<string, string> = {
  'Spark of ': '618967225',
  'Ember of ': '1186062409',
  'Echo of ': '1907852650',
  'Whisper of ': '1088259962',
  'Thread of ': '1870531554',
  'Facet of ': '1918152785',
};
export function compendiumPreferredTabs(category: string, name: string): string[] {
  if (category === 'armor-mod-general' && /^Set Bonus:\s*/.test(name)) return ['1287885342'];
  const fragment =
    category === 'subclass-fragment' &&
    Object.entries(fragmentTabs).find(([prefix]) => name.startsWith(prefix))?.[1];
  return fragment ? [fragment] : (compendiumCategoryTabs[category] ?? []);
}
export function compendiumNameVariants(category: string, name: string): string[] {
  const names = [name];
  if (category === 'subclass-fragment') {
    const prefix = Object.keys(fragmentTabs).find((prefix) => name.startsWith(prefix));
    if (prefix) names.push(name.slice(prefix.length));
  }
  if (category === 'armor-mod-general') {
    names.push(name.replace(/^Set Bonus:\s*/, ''));
    names.push(name.replace(/\b(?:Arc|Solar|Void|Stasis|Strand|Harmonic|Kinetic)\s+/g, ''));
    if (/^(?:Heavy|Special) Ammo (?:Finder|Scout)$/.test(name)) {
      names.push(name.replace(/^(?:Heavy|Special) /, ''));
    }
  }
  if (category === 'subclass-grenade') names.push(name.replace(/\s+Grenade$/, ''));
  if (category === 'weapon-catalyst-exotic') {
    names.push(name.replace(/\s+catalyst$/i, ''));
    const weapon = Object.hasOwn(catalystWeapons, name) ? catalystWeapons[name] : undefined;
    if (weapon) names.push(weapon);
  }
  if (category === 'weapon-trait-exotic' || category === 'weapon-frame-exotic') {
    const source = Object.hasOwn(exoticSourceNames, name) ? exoticSourceNames[name] : undefined;
    if (source) names.push(source);
  }
  return [...new Set(names)];
}
// These traits share a named weapon cell or use the source's older trait name.
const exoticSourceNames: Record<string, string> = {
  'Spinning Up': 'SUROS Regime',
  'Dual Speed Receiver': 'SUROS Regime',
  'Time-Slip': 'No Time to Explain',
  'Restorative Turret': 'Healing Turret',
  'The Scientific Method': 'Scientific Method',
  'Tri-Planar Mass Driver': 'Tri-Planar Mass',
  'Resurgence Directive II': 'Resurgence Directive',
  'Resurgence Directive III': 'Resurgence Directive',
  'Resurgence Directive IV': 'Resurgence Directive',
};
const catalystWeapons: Record<string, string> = {
  'Jade Rabbit Catalyst': 'The Jade Rabbit',
  'Prometheus Catalyst': 'Prometheus Lens',
  'Wardcliff Coil Catalyst': 'The Wardcliff Coil',
  'Worldline Catalyst': 'Worldline Zero',
  'Whisper Catalyst': 'Whisper of the Worm',
  'Khvostov Catalyst': 'Khvostov 7G-0X',
  'Acrius Catalyst': 'Legend of Acrius',
  'Skyburner Catalyst': "Skyburner's Oath",
  'Colony Catalyst': 'The Colony',
  'Prospector Catalyst': 'The Prospector',
};
export function compendiumIdentifiers(name: string): string[] {
  const identifiers = [
    name,
    ...name
      .split('\n')
      .map((line) => line.replace(/^[↑+\s]+/u, '').trim())
      .filter(Boolean),
  ];
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  return identifiers.flatMap((identifier) => {
    const range = /^(.*?) ([IVX]+)[–-]([IVX]+)$/.exec(identifier);
    if (!range) return [identifier];
    const start = roman.indexOf(range[2]);
    const end = roman.indexOf(range[3]);
    return start < 0 || end < start
      ? [identifier]
      : [
          identifier,
          range[1],
          ...roman.slice(start, end + 1).map((suffix) => `${range[1]} ${suffix}`),
        ];
  });
}
