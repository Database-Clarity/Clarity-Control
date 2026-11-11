
import { DescriptionFilter } from '../converterSettings.js'
import { IntermediatePerk } from '../types.js'
import { pick } from '../helpers.js'

export const getDataFromPerk = (perk: IntermediatePerk, filters: DescriptionFilter['getFromPerk']) => {
  const getFromPerk = ['hash', 'name', 'itemHash', 'itemName', 'editor']

  Object.entries(filters).forEach(([filterName, value]) => {
    if (value && typeof value === 'boolean') {
      getFromPerk.push(filterName)
    }
  })

  const newPerk = pick(perk, getFromPerk)

  // get selected languages
  const filteredDescriptionLanguages = pick(newPerk.editor, filters.languages || [])
  const filteredUpdateTrackerLanguages = pick(newPerk.updateTracker?.descriptions, filters.languages || [])

  const updateTracker = {
    descriptions: filteredUpdateTrackerLanguages,
    stats: filters.stats ? newPerk.updateTracker?.stats : undefined
  }

  return {
    ...newPerk,
    editor: filteredDescriptionLanguages,
    updateTracker: filters.updateTracker ? updateTracker : undefined
  }
}
