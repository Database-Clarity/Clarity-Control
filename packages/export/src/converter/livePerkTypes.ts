// If you see "Optional" then it is optional and probably not included by default
// If something is not clear just ask if you think you can improve explanation make PR
// Formula is the wording we use for in-game functionality calculators like Damage Falloff, Ready/Stow Speed, and Reload Speed.

/**
 ** Perk types are not the same as Bungie's
 */
export type LivePerkTypes =
  | 'Armor Trait Exotic'
  | 'Armor Mod General'
  | 'Armor Mod Combat'
  | 'Armor Mod Activity'
  | 'Armor Mod Seasonal'
  // ---------
  | 'Weapon Perk'
  | 'Weapon Perk Exotic'
  // ---------
  | 'Weapon Trait'
  | 'Weapon Trait Exotic'
  | 'Weapon Trait Origin'
  | 'Weapon Trait Origin Exotic'
  | 'Weapon Trait Enhanced'
  | 'Weapon Trait Enhanced Exotic'
  // ---------
  | 'Weapon Frame'
  | 'Weapon Frame Exotic'
  | 'Weapon Frame Enhanced'
  | 'Weapon Frame Enhanced Exotic'
  // ---------
  | 'Weapon Catalyst Exotic'
  // ---------
  | 'Weapon Mod'
  // ---------
  | 'Subclass Fragment'
  | 'Subclass Aspect'
  | 'Subclass Super'
  | 'Subclass Grenade'
  | 'Subclass Melee'
  | 'Subclass Class'
  | 'Subclass Movement'
  // ---------
  | 'Ghost Mod'

/**
 ** Stats names are not the same as Bungie's
 */
export type StatNames =
  | 'ADS' // Handling modifiers that only apply to ADS Speed
  | 'Aim Assist'
  | 'Airborne' // Airborne Effectiveness
  | 'Blast Radius'
  | 'Charge Draw' // Charge Time and Draw Time combined
  | 'Damage' // For internal use only
  | 'Firing Delay'
  | 'Guard Charge Rate'
  | 'Guard Efficiency'
  | 'Guard Endurance'
  | 'Guard Resistance'
  | 'Handling'
  | 'PVE Damage'
  | 'PVP Damage'
  | 'Range'
  | 'Ready' // Handling modifiers that only apply to Ready Speed
  | 'Recoil Direction'
  | 'Reload'
  | 'RPM' // Rounds Per Minute modifiers used by perks like Adagio
  | 'Stability'
  | 'Stow' // Handling modifiers that only apply to Stow Speed
  | 'Zoom'

/**
 ** Weapon types are not the same as Bungie's
 */
export type WeaponTypes =
  | 'AR' // Auto Rifle
  | 'Bow' // (Combat) Bow
  | 'Fusion' // Fusion Rifle
  | 'GL' // Grenade Launcher
  | 'Glaive' // Glaive
  | 'HC' // Hand Cannon
  | 'Heavy GL' // Heavy (Drum-Loaded) Grenade Launcher
  | 'LFR' // Linear Fusion Rifle
  | 'LMG' // Machine Gun
  | 'Pulse' // Pulse Rifle
  | 'Rocket' // Rocket Launcher
  | 'Scout' // Scout Rifle
  | 'Shotgun' // Shotgun - includes slug and pellet shotguns
  | 'Sidearm' // Sidearm
  | 'SMG' // Submachine Gun
  | 'Sniper' // Sniper Rifle
  | 'Sword' // Sword
  | 'Trace' // Trace Rifle
  /** Ability "WeaponTypes" are generally used for ability damage increases from mods/exotics */
  | 'Grenade'
  | 'Melee'
  | 'Super'

/**
 ** Languages are the same as Bungie's
 ** We do not guarantee the accuracy of the localized perk definitions as very few people are willing to commit to such a time sink.
 ** Therefore, we have no way of validating the accuracy of the translation and are working purely on a good faith system with 0 tolerance for griefing.
 ** Please report any inaccuracies/issues to us directly.
 */
export type Languages =
  /** English - English */
  | 'en'
  /** German - Deutsch */
  | 'de'
  /** French - Français */
  | 'fr'
  /** Italian - Italiano */
  | 'it'
  /** Polish - Polski */
  | 'pl'
  /** Russian - Русский */
  | 'ru'
  /** Spanish (Spain) - Español (España) */
  | 'es'
  /** Spanish (Mexico) - Español (México) */
  | 'es-mx'
  /** Korean - 한국어 */
  | 'ko'
  /** Portuguese (Brazil) - Português (Brasil) */
  | 'pt-br'
  /** Japanese - 日本語 */
  | 'ja'
  /** Chinese (Traditional) - 繁體中文 */
  | 'zh-cht'
  /** Chinese (Simplified) - 简体中文 */
  | 'zh-chs'

type Stat = {
  /**
   ** Types of weapons these stats apply to
   ** These are our custom weapon type names
   ** Optional
   */
  weaponTypes?: WeaponTypes[]

  /**
   ** Stats that have activation conditions like a weapon kill
   */
  active?: {
    /**
     ** Array index is key for formulas in perk descriptions
     ** Calculated stat * multiplier
     */
    multiplier?: number[]

    /**
     ** Array index is key for formulas in perk descriptions
     ** Bungie stat + stat
     */
    stat?: number[]
  }

  /**
   ** Stats that are passively active but aren't included in Bungie's investment stats
   */
  passive?: {
    /**
     ** Array index is key for formulas in perk descriptions
     ** Calculated stat * multiplier
     */
    multiplier?: number[]

    /**
     ** Array index is key for formulas in perk descriptions
     ** Bungie stat + stat
     */
    stat?: number[]
  }
}

type Stats = {
  /**
   ** Stats names are not the same as Bungie's, these use our custom stat names
   */
  [key in StatNames]?: Stat[]
}

type LinesContent = {
  /**
   ** Text in this part of the line
   */
  text?: string

  /**
   ** Class names for this part of the line
   */
  classNames?: string[]

  /**
   ** If this line has a link then this line and its text are part of the link
   */
  link?: string

  /**
   ** If this line has a formula then this line and its text are part of the formula
   */
  formula?: string

  /**
   ** If this line has a title then this line and its text are part of the title
   */
  title?: DescriptionLine[]
}

type CellContent = {
  /**
   ** Text in this part of the cell (\<span>)
   */
  text?: string

  /**
   ** This will be moved from here when converting description
   */
  classNames?: string[]

  /**
   ** If this part of cell (\<span>) has link then this part of the cell (\<span>) and its text are part of the link
   */
  link?: string

  /**
   * If this part of cell (\<span>) has formula then this part of the cell (\<span>) and its text are part of the formula
   */
  formula?: string

  /**
   ** If this part of cell (\<span>) has title then this part of the cell (\<span>) and its text are part of the title
   */
  title?: DescriptionLine[]
}

/**
 ** Contents of a row in tables (\<tr>) - array of cells
 */
type RowContent = {
  /**
   ** Contents of cell (\<td>) - array of spans (\<span>)
   */
  cellContent: CellContent[]

  /**
   ** Number of cells to span horizontally (Cell Width - integer)
   */
  colSpan?: number

  /**
   ** Number of cells to span vertically (Cell Height - integer)
   */
  rowSpan?: number

  /**
   ** This will be moved from here when converting description
   */
  classNames?: string[]
}

type TableLine = {
  /**
   ** Contents of table row (\<tr>)
   */
  rowContent?: RowContent[]

  /**
   ** Table row (\<tr>) class names
   */
  classNames?: string[]
}

type DescriptionLine = {
  /**
   ** Line (\<div>) class names
   */
  classNames?: string[]

  /**
   ** Contents of line (\<span>)
   */
  linesContent?: LinesContent[]

  /**
   ** Is table content only formulas (aka leaving it out doesn't take away any important information from the perk definition)
   */
  isFormula?: boolean

  /**
   * Contents of table (\<table>)
   */
  table?: TableLine[]

  /**
   ** If this exists that means this line only applies to some of the weapon types defined at the top
   */
  weaponTypes?: (string | undefined)[]
}

export type LivePerk = {
  /**
   ** Perk, Mod, etc. hash
   ** InventoryItem hash
   */
  hash: number

  /**
   ** Perk, Mod, etc. name
   ** InventoryItem displayProperties name
   */
  name: string

  /**
   ** Hash of item perk belongs to (Exotic Weapon/Armor)
   ** InventoryItem hash
   */
  itemHash?: number

  /**
   ** Name of item perk belongs to (Exotic Weapon/Armor)
   ** InventoryItem displayProperties name
   */
  itemName?: string

  /**
   ** Nickname of person who uploaded this perk to the database
   ** Optional, only for tracking purposes
   */
  uploadedBy: string

  /**
   ** Type of the perk as defined at the top
   ** Optional, only for organization purposes
   */
  type: LivePerkTypes

  /**
   ** Date in ms when the perk was last updated by us
   ** Optional
   */
  updateTracker: {
    /**
     ** Stats have to be enabled for this to show up
     ** Shows up on all perks regardless if they have stats or don't
     */
    stats: {
      /**
       ** Date in ms when stats were last changed
       */
      lastUpdate: number

      /**
       ** Name of the person who last updated the stats
       */
      updatedBy: string
    }
    descriptions: {
      /**
       ** Languages are the same as Bungie's
       */
      [key in Languages]?: {
        /**
         ** Date in ms when the perk was last updated by us
         */
        lastUpdate: number

        /**
         ** Name of the person who last updated the perk definition
         */
        updatedBy: string
      }
    }
  }
  descriptions: {
    /**
     ** Descriptions can be converted to custom string (code for that is already made)
     ** They can also be converted to something custom that a partner would prefer.
     ** If you can provide your own converter, we can directly implement it so it will get updated at the same time as our already supported formats.
     ** Please don't hesitate to ask us about this. It will save you the step of having to convert it on your end. (And future partners may even prefer your format for their use case.)
     ** Languages are the same as Bungie's
     */
    [key in Languages]?: DescriptionLine | string
  }

  /**
   ** This does not include investment stats from Bungie
   ** Optional
   */
  stats?: Stats

  /**
   ** Hashes of related perks (e.g. exotic → keyword verbs), in the order they should be shown
   ** Each hash is published as its own entry
   ** Optional
   */
  associated?: number[]
}

/**
 ** Alias of another perk, published by settings with `aliases: 'reference'`
 ** Everything else (descriptions, stats, ...) is on the perk with hash `aliasOf`
 ** Only published when that perk is published as well
 */
export type LiveAlias = {
  /**
   ** Hash of the alias
   */
  hash: number

  /**
   ** Hash of the perk this alias is an alias of
   */
  aliasOf: number
}
