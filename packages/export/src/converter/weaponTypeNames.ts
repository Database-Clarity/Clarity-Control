import { weaponTypes } from './data.js'

/**
 ** Bungie manifest weapon item subtype names, the names `<weapons …>` blocks use
 ** Same list as the editor's weaponTypeNames (test/weaponTypes.test.mjs pins it)
 */
export const weaponTypeNames = [
  'Auto Rifle',
  'Combat Bow',
  'Fusion Rifle',
  'Glaive',
  'Grenade Launcher',
  'Hand Cannon',
  'Linear Fusion Rifle',
  'Machine Gun',
  'Pulse Rifle',
  'Rocket Launcher',
  'Scout Rifle',
  'Shotgun',
  'Sidearm',
  'Sniper Rifle',
  'Submachine Gun',
  'Sword',
  'Trace Rifle'
] as const

/**
 ** Tags that are not manifest weapon types: abilities and an ammo split
 */
export const weaponTypeExtraTags = ['Grenade', 'Melee', 'Super', 'Heavy Grenade Launcher'] as const

/**
 ** Every name a `<weapons …>` block may list
 */
export const allWeaponTypeNames: readonly string[] = [...weaponTypeNames, ...weaponTypeExtraTags]

/**
 ** Abbreviations of the old `< weapon type (…) >` syntax in lower case, mapped to the names above
 ** Names that are the same in both (Glaive, Shotgun, Sidearm, Sword, Grenade, Melee, Super) are not listed
 */
export const legacyWeaponTypeNames: Readonly<{ [abbreviation: string]: string }> = {
  ar: 'Auto Rifle',
  bow: 'Combat Bow',
  fusion: 'Fusion Rifle',
  gl: 'Grenade Launcher',
  hc: 'Hand Cannon',
  'heavy gl': 'Heavy Grenade Launcher',
  lfr: 'Linear Fusion Rifle',
  lmg: 'Machine Gun',
  pulse: 'Pulse Rifle',
  rocket: 'Rocket Launcher',
  scout: 'Scout Rifle',
  smg: 'Submachine Gun',
  sniper: 'Sniper Rifle',
  trace: 'Trace Rifle'
}

const canonicalByLowercase = new Map(allWeaponTypeNames.map((name) => [name.toLowerCase(), name]))

/**
 * Name of the weapon type (case-insensitive), old abbreviations only when `legacy` is set
 */
export const canonicalWeaponType = (name: string, legacy = false): string | undefined => {
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase()
  return canonicalByLowercase.get(key) ?? (legacy ? legacyWeaponTypeNames[key] : undefined)
}

/**
 * Old names (AR, HC, Heavy GL, …) of the weapon types in the order the old syntax listed them
 */
const legacyNames = weaponTypes.map((legacyName) => ({ legacyName, name: canonicalWeaponType(legacyName, true) }))

/**
 * Converts names to the old names, for outputs that still use them. `other` lists get the order of the old list
 */
export const toLegacyWeaponTypes = (names: readonly string[], sort: boolean): string[] => {
  const legacy = names.flatMap((name) => legacyNames.find((entry) => entry.name === name)?.legacyName ?? [])
  return sort ? weaponTypes.filter((legacyName) => legacy.includes(legacyName)) : legacy
}
