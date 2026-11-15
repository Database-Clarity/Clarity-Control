import { doMath } from './converterFunctions/math.js'
import { extractTitles } from './converterFunctions/extractTitles.js'
import { loadExports } from './converterFunctions/loadExports.js'
import { loadVariables } from './converterFunctions/loadVariables.js'
import { removePerkSpecificText } from './converterFunctions/removePerkSpecificText.js'
import { removeUnusedText } from './converterFunctions/removeUnusedText.js'
import { separateTableWeaponType } from './converterFunctions/separateTableWeaponType.js'
import { DescriptionData, DescriptionLine } from './types.js'

const prepareDescription = (descriptionData: DescriptionData) => {
  const { language, hash, database } = descriptionData
  let description = loadExports(descriptionData)

  // removes enhanced/exotic perks and catalysts if perk is not enhanced/exotic perk or catalyst
  description = removePerkSpecificText(description, database[hash].type)

  description = loadVariables({ ...descriptionData, descriptionString: description })
  // Title bodies are prepared separately below; retain dot spelling for their single format pass.
  const titles = extractTitles(removeUnusedText(description, false))
  // Stale or unfreezable fallback text keeps English numbers; real translations use their
  // language even when resolving number tokens makes their text identical to English.
  description = doMath(description, database[hash].editor[language]?.englishFallback ? 'en' : language)

  return {
    preparedDescription: removeUnusedText(description.trim()),
    titles: {
      ...titles,
      ...extractTitles(database[3].editor[language]?.main),
      ...extractTitles(database[3].editor[language]?.secondary)
    }
  }
}

export const descriptionConverter = (descriptionData: DescriptionData) => {
  const { preparedDescription, titles } = prepareDescription(descriptionData)

  const convertedTitles = Object.entries(titles || {}).reduce<{ [key: string]: DescriptionLine[] }>(
    (acc, [titleName, titleContent]) => {
      const { preparedDescription } = prepareDescription({ ...descriptionData, descriptionString: titleContent })

      const convertedTitles = separateTableWeaponType(preparedDescription, {})
      if (convertedTitles) acc[titleName] = convertedTitles
      return acc
    },
    {}
  )

  return separateTableWeaponType(preparedDescription, convertedTitles)
}
