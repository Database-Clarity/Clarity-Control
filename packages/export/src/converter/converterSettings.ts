import { allClassNames, images, languageKeys } from './data.js'
import { Languages } from './livePerkTypes.js'
import { AllClassNames } from './types.js'

export type DescriptionFilter = {
  getFromPerk: {
    /**
     ** Time when perk was uploaded
     */
    lastUpload: boolean

    /**
     ** Discontinued, set to false
     */
    stats: boolean

    /**
     ** Custom perks types, for example "Weapon Perk Exotic" or "Armor Mod Seasonal"
     */
    type: boolean

    /**
     ** Nickname of person who uploaded description
     */
    uploadedBy: boolean

    /**
     ** Time when changes were made and nickname of the person who made changes
     ** Includes description in all languages separately
     */
    updateTracker: boolean

    /**
     ** Canonical hashes of related tooltips (e.g. exotic → keyword verbs); each is published as its own entry
     */
    associated: boolean

    /**
     ** Which languages to include; if undefined includes all languages
     */
    languages: Languages[] | undefined
  }

  getFromDescription: {
    /**
     ** Discontinued, set to false
     */
    formula: boolean

    /**
     ** External links pointing to some resources that provide important context about
     ** the contents of the tooltips
     */
    link: boolean

    /**
     ** Custom title ("hover tooltip") with additional information about specific strings of text
     */
    title: boolean

    /**
     ** Discontinued, set to false
     */
    table: boolean

    /**
     ** List of classNames to include
     ** If undefined includes everything
     */
    includeClassNames: AllClassNames[] | undefined

    /**
     ** List of classNames to remove
     ** If empty array does nothing
     */
    excludeClassNames: AllClassNames[]
  }

  /**
   ** How aliases (the same tooltip published under more than one hash) are output
   ** 'legacy' frame aliases are output as full copies of the original, sandbox aliases are omitted
   ** 'reference' every alias is output as { hash, aliasOf } and nothing else
   */
  aliases: 'legacy' | 'reference'

  /**
   ** Complicated stuff
   */
  editor: 'main' | 'secondary'

  /**
   ** Discontinued, set it to whatever you want
   */
  optional: boolean

  /**
   ** If you want to replace the "enhanced arrow" (🡅) with something else
   ** Provide a value to replace it with otherwise undefined
   */
  enhancedArrowReplacement: string | undefined

  /**
   ** Very basic converter allows converting description to simple string
   ** Can be used to make markdown or similar formats
   ** Take a look at Crayon's, Braytech's, or Vault Zero's configurations below
   */
  toStringConverterOptions?: {
    /**
     ** Adds text to the beginning and end of a string
     */
    classNames?: {
      [key in AllClassNames]?: [string, string]
    }

    /**
     ** The first 2 are for the beginning and end of the string
     ** The last 2 are for the beginning and end of the "hover tooltip" contents
     */
    title?: [string, string, string, string]

    /**
     ** The first 2 are for the beginning and end of the string
     ** The last 2 are for the beginning and end of the URL
     */
    link?: [string, string, string, string]
  }
}

// things to include perks
export const converterSettings: { [key: string]: DescriptionFilter } = {
  clarity: {
    getFromPerk: {
      lastUpload: true,
      stats: true,
      type: true,
      uploadedBy: true,
      updateTracker: false,
      associated: false,
      languages: undefined
    },
    getFromDescription: {
      formula: true,
      link: true,
      title: true,
      table: true,

      includeClassNames: undefined,
      excludeClassNames: []
    },
    enhancedArrowReplacement: undefined,

    aliases: 'legacy',
    editor: 'main',
    optional: false
  },
  dim: {
    getFromPerk: {
      lastUpload: false,
      stats: false,
      type: false,
      uploadedBy: false,
      updateTracker: false,
      associated: false,
      languages: undefined
    },
    getFromDescription: {
      formula: false,
      link: true,
      title: false,
      table: false,

      includeClassNames: ['spacer', 'center', 'bold', 'breakSpaces', 'background', 'enhancedArrow', ...images],
      excludeClassNames: []
    },
    enhancedArrowReplacement: '',

    aliases: 'legacy',
    editor: 'secondary',
    optional: false
  },
  crayon: {
    getFromPerk: {
      lastUpload: true,
      stats: true,
      type: true,
      uploadedBy: true,
      updateTracker: false,
      associated: false,
      languages: undefined
    },
    getFromDescription: {
      formula: false,
      link: true,
      title: false,
      table: false,

      includeClassNames: [
        'spacer',
        'stasis',
        'arc',
        'solar',
        'void',
        'primary',
        'special',
        'heavy',
        'pve',
        'pvp',
        'background',
        'bold'
      ],
      excludeClassNames: []
    },
    enhancedArrowReplacement: undefined,

    aliases: 'legacy',
    editor: 'secondary',
    optional: true,
    toStringConverterOptions: {
      classNames: {
        stasis: ['<:stasis:915198000727461909>', ''],
        arc: ['<:arc:720178925317128243>', ''],
        solar: ['<:solar:720178909361995786>', ''],
        void: ['<:void:720178940240461864>', ''],
        primary: ['<:primary:968793055677251604>', ''],
        special: ['<:special:968793055631114330>', ''],
        heavy: ['<:heavy:968793055652106320>', ''],

        pve: ['<:pve:922884406073507930>', ''],
        pvp: ['<:pvp:922884468275019856>', ''],

        background: ['**', '**'],
        bold: ['**', '**']
      },
      link: ['[', ']', '(', ')']
    }
  },
  foundry: {
    getFromPerk: {
      lastUpload: true,
      stats: false,
      type: true,
      uploadedBy: true,
      updateTracker: true,
      associated: false,
      languages: undefined
    },
    getFromDescription: {
      formula: false,
      link: false,
      title: false,
      table: false,

      includeClassNames: ['spacer', 'breakSpaces', 'enhancedArrow', ...images],
      excludeClassNames: []
    },
    enhancedArrowReplacement: undefined,

    aliases: 'legacy',
    editor: 'secondary',
    optional: false
  },
  lightGG: {
    getFromPerk: {
      lastUpload: true,
      stats: false,
      type: false,
      uploadedBy: false,
      updateTracker: true,
      associated: false,
      languages: undefined
    },
    getFromDescription: {
      formula: false,
      link: true,
      title: false,
      table: false,

      includeClassNames: ['spacer', 'center', 'bold', 'breakSpaces', 'background', 'enhancedArrow'],
      excludeClassNames: []
    },
    enhancedArrowReplacement: undefined,

    aliases: 'legacy',
    editor: 'secondary',
    optional: false
  },
  braytech: {
    getFromPerk: {
      lastUpload: true,
      stats: true,
      type: true,
      uploadedBy: true,
      updateTracker: false,
      associated: false,
      languages: undefined
    },
    getFromDescription: {
      formula: false,
      link: true,
      title: false,
      table: false,

      includeClassNames: [
        'solar',
        'void',
        'arc',
        'stasis',
        'strand',

        'primary',
        'special',
        'heavy',

        'pve',
        'pvp',

        'background',        
        'spacer',
        'bold'
      ],
      excludeClassNames: []
    },
    enhancedArrowReplacement: undefined,

    aliases: 'legacy',
    editor: 'main', // copied from clarity but crayon used secondary ???
    optional: false, // same as above
    toStringConverterOptions: {
      classNames: {
        solar: ['', ''],
        void: ['', ''],
        arc: ['', ''],
        stasis: ['', ''],
        strand: ['', ''],

        primary: ['', ''],
        special: ['', ''],
        heavy: ['', ''],
        
        titan: ['', ''],
        hunter: ['', ''],
        warlock: ['', ''],
        
        bold: ['**', '**']
      },
      link: ['[', ']', '(', ')']
    }
  },
  vaultZero: {
    getFromPerk: {
      lastUpload: false,
      stats: true,
      type: true,
      uploadedBy: false,
      updateTracker: false,
      associated: false,
      languages: ['en']
    },
    getFromDescription: {
      formula: false,
      link: true,
      title: false,
      table: false,

      includeClassNames: [
        'enhancedArrow',
        
        'arc',
        'solar',
        'stasis',
        'strand',
        'void',
        
        'primary',
        'special',
        'heavy',

        'barrier',
        'overload',
        'unstoppable',

        'pve',
        'pvp',
        
        'bold'
      ],
      excludeClassNames: []
    },
    enhancedArrowReplacement: '[enh]',

    aliases: 'legacy',
    editor: 'secondary',
    optional: true,
    toStringConverterOptions: {
      classNames: {
        arc:         ['[Arc]',           ''],
        solar:       ['[Solar]',         ''],
        stasis:      ['[Stasis]' ,       ''],
        strand:      ['[Strand]',        ''],
        void:        ['[Void]'   ,       ''],
          
        primary:     ['[primary]',       ''],
        special:     ['[special]',       ''],
        heavy:       ['[heavy]'  ,       ''],
  
        barrier:     ['[barrier]',       ''],
        overload:    ['[overload]',      ''],
        unstoppable: ['[unstoppable]',   ''],
  
        pve:         ['[pve]',           ''],
        pvp:         ['[pvp]',           ''],

        bold:        ['**',            '**']
      },
      link: ['[', ']', '(', ')']
    }
  },
  // Output of the v2 editor: same as clarity, plus associations; stats are dropped because v2 data is stat-free
  clarityV2: {
    getFromPerk: {
      lastUpload: true,
      stats: false,
      type: true,
      uploadedBy: true,
      updateTracker: false,
      associated: true,
      languages: undefined
    },
    getFromDescription: {
      formula: true,
      link: true,
      title: true,
      table: true,

      includeClassNames: undefined,
      excludeClassNames: []
    },
    enhancedArrowReplacement: undefined,

    aliases: 'reference',
    editor: 'main',
    optional: false
  }
}
export const getSettings = (name: string): DescriptionFilter => {
  const settings = converterSettings[name]
  const includedClassNames = settings.getFromDescription.includeClassNames || allClassNames

  return {
    ...settings,
    getFromPerk: {
      ...settings.getFromPerk,
      languages: settings.getFromPerk.languages === undefined ? languageKeys : settings.getFromPerk.languages
    },
    getFromDescription: {
      ...settings.getFromDescription,
      includeClassNames: includedClassNames.filter(
        (className) => !settings.getFromDescription.excludeClassNames.includes(className)
      )
    }
  }
}
