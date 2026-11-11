import { allClassNames, classNameList } from './data.js'
import { Languages, LivePerkTypes, StatNames, WeaponTypes } from './livePerkTypes.js'

export type PerkTypes = LivePerkTypes | 'none'

export type AllClassNames = (typeof allClassNames)[number]
export type TableClassNames = (typeof classNameList.table)[number]

export type DescriptionData = {
  descriptionString: string
  editorType: 'main' | 'secondary'
  language: Languages
  hash: number
  /** Must be expanded, see expandAliases */
  database: ExpandedPerks
}

export type Stat = {
  weaponTypes?: WeaponTypes[]
  active?: {
    multiplier?: number[]
    stat?: number[]
  }
  passive?: {
    multiplier?: number[]
    stat?: number[]
  }
}
export type Stats = {
  [key in StatNames]?: Stat[]
}

export type Editor = {
  [key in Languages]?: {
    main: string
    secondary: string
  }
}

export type IntermediatePerk = {
  hash: number
  name: string
  itemHash?: number
  itemName?: string
  uploadedBy: string
  type: PerkTypes
  importStatsFrom?: number
  updateTracker: {
    stats?: {
      lastUpdate: number
      updatedBy: string
    }
    descriptions: {
      [key in Languages]?: {
        lastUpdate: number
        updatedBy: string
      }
    }
  }
  editor: Editor
  stats?: Stats
  duration?: number[]
  activationCondition?: string
  /** Canonical hashes of related tooltips, in authored order; only published when the settings ask for it */
  associated?: number[]
  /** Names of the weapon types (weaponTypeNames.ts) this perk is on, never published. Used to specialise weapon type blocks */
  weaponTypes?: string[]
  lastUpload: number
  inLiveDatabase: boolean
  uploadToLive: boolean
}

/**
 * Intermediate form of an alias: a tooltip that is published under a second hash.
 * Only the alias's own catalog facts are present, everything else is looked up on `aliasOf`
 */
export type AliasStub = {
  hash: number
  /** Hash of the canonical perk this alias points at */
  aliasOf: number
  aliasKind: 'sandbox' | 'frame'
  name?: string
  type?: PerkTypes
  itemHash?: number
  itemName?: string
  /** Weapon types of the alias, replaces the ones of the original when the stub has any facts */
  weaponTypes?: string[]
}

/** Perks as stored in the intermediate database, aliases may be stubs */
export type IntermediatePerks = {
  [key in string]: IntermediatePerk | AliasStub
}

/** Perks with every alias stub expanded into a full copy, see expandAliases */
export type ExpandedPerks = {
  [key in string]: IntermediatePerk
}

export type FolderTypes = 'Weapon Frame Exotic' | 'Weapon Frame' | 'Weapon Frame Enhanced'
export type Database = {
  perks: IntermediatePerks

  databaseSettings: {
    folders: {
      [key in FolderTypes]: {
        name: string
        has: number[]
        hash?: number
      }[]
    }
    enhancedPerks: {
      [key: string]: {
        name: string
        linkedWith: number
      }
    }
    /** Singular label of each weapon type per language, used for weapon type blocks of perks on several weapon types */
    weaponTypeLabels?: WeaponTypeLabels
  }
}

export type WeaponTypeLabels = {
  [weaponType: string]: { [key in Languages]?: string }
}

export type LinesContent = {
  /** Text in this part of the line */
  text?: string
  /** Class names of this parts of the line */
  classNames?: (string | undefined)[]
  /** If this line has URL then this line and its text is part of link */
  link?: string
  /** If this line has formula then this line and its text is part of formula */
  formula?: string
  /** If this line has title then this line and its text is part of title */
  title?: DescriptionLine[]
}

export type CellContent = {
  /** Text in this part of the cell \<span> */
  text?: string
  /** this will be moved from hare when converting description */
  classNames?: (string | undefined)[]
  /** If this part of cell \<span> has URL then this part of the cell \<span> and its text is part of link */
  link?: string
  /** If this part of cell \<span> has formula then this part of the cell \<span> and its text is part of formula */
  formula?: string
  /** If this part of cell \<span> has title then this part of the cell \<span> and its text is part of title */
  title?: DescriptionLine[]
  /** this will be moved from hare when converting description */
  colSpan?: number
  /** this will be moved from hare when converting description */
  rowSpan?: number
  /** this will be moved from hare when converting description */
  cellClassNames?: (string | undefined)[]
}

/** Contents of table row \<tr> aka array of cells */
export type RowContent = {
  /** Contents of cell \<td> aka array of spans \<span> */
  cellContent: CellContent[]
  /** Number of cell to span horizontally */
  colSpan?: number
  /** Number of cell to span vertically */
  rowSpan?: number
  /** this will be moved from hare when converting description */ //todo fix explanation
  classNames?: (string | undefined)[]
}

export type TableLine = {
  /** Contents of table row \<tr> aka array of cells */
  rowContent?: RowContent[]
  /** row \<tr> classNames */
  classNames?: (string | undefined)[]
}

export type DescriptionLine = {
  /** Lines \<div> class names */
  classNames?: (string | undefined)[]
  /** Contents of line \<span> */
  linesContent?: LinesContent[]
  /** Is table content only formulas */
  isFormula?: boolean | undefined
  /** Contents of table \<table> */
  table?: TableLine[]
  /** @deprecated Legacy input-only section labels; removed from filtered output. */
  weaponTypes?: (string | undefined)[]
  /** @deprecated Legacy input-only section identifier. */
  weaponBlock?: number
  /** @deprecated Legacy input-only other-section marker. */
  weaponOther?: boolean
}
