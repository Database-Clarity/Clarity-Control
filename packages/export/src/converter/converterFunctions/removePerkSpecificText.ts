import { LivePerkTypes } from '../livePerkTypes.js'

export const removePerkSpecificText = (description: string, perkType: LivePerkTypes | 'none') => {
  const enhancedExports = description.match(/^enhanced \([\s\S]*?\n\)$/gm)

  if (enhancedExports && perkType !== 'Weapon Trait Enhanced') {
    enhancedExports.forEach((enhancedExport) => {
      description = description.replace(enhancedExport, '')
    })
    description = description.replaceAll('#e', '')
  }

  const catalystExports = description.match(/^catalyst \([\s\S]*?\n\)$/gm)

  if (catalystExports && perkType !== 'Weapon Catalyst Exotic') {
    catalystExports.forEach((catalystExport) => {
      description = description.replace(catalystExport, '')
    })
  }

  const exoticPerkExports = description.match(/^exotic perk \([\s\S]*?\n\)$/gm)

  if (exoticPerkExports && perkType !== 'Weapon Perk Exotic') {
    exoticPerkExports.forEach((exoticPerkExport) => {
      description = description.replace(exoticPerkExport, '')
    })
  }

  return description
}
