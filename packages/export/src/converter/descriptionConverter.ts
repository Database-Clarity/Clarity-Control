import { doMath } from './converterFunctions/math.js'
import { extractTitles } from './converterFunctions/extractTitles.js'
import { loadExports } from './converterFunctions/loadExports.js'
import { loadVariables } from './converterFunctions/loadVariables.js'
import { removePerkSpecificText } from './converterFunctions/removePerkSpecificText.js'
import { removeUnusedText } from './converterFunctions/removeUnusedText.js'
import { separateTableWeaponType } from './converterFunctions/separateTableWeaponType.js'
import { DescriptionData, DescriptionLine } from './types.js'
import { parseMarkup } from '@clarity/core/markup/parse'

/** Native inline nodes use the editor's real resolver, in the importing perk's context. */
const nativeDescription = (descriptionData: DescriptionData, description: string) => {
  const { database, hash, language } = descriptionData
  const library = (id: number) => {
    const text = database[id]?.editor[language]
    return [text?.main, text?.secondary].filter(Boolean).join('\n')
  }
  const variables = library(2)
  const rawTitles = library(3)
  // Use the real import resolver for global title bodies too, including pairs assembled by
  // mid-line splices. No copied dependency walk, or early selection of an imported perk's arm.
  const titles = rawTitles.includes('import ')
    ? loadExports({ ...descriptionData, descriptionString: rawTitles }) : rawTitles
  if (![description, variables, titles].some((source) => source.includes('{{'))) return undefined
  const editor = database[hash].editor
  const parsed = parseMarkup(description, {
    variables, titles, type: database[hash].type,
    lang: editor[language]?.main === editor.en?.main ? 'en' : language
  })
  const error = parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  if (error) throw new Error(`Tooltip ${hash} (${language}): ${error.message}`)
  return parsed.lines
}

const prepareDescription = (descriptionData: DescriptionData, imported?: string) => {
  const { language, hash, database } = descriptionData
  let description = imported ?? loadExports(descriptionData)

  // removes enhanced/exotic perks and catalysts if perk is not enhanced/exotic perk or catalyst
  description = removePerkSpecificText(description, database[hash].type)

  description = loadVariables({ ...descriptionData, descriptionString: description })
  // Title bodies are prepared separately below; retain dot spelling for their single format pass.
  const titles = extractTitles(removeUnusedText(description, false))
  // Core exports English fallback as an exact copy, which keeps English decimals too.
  const editor = database[hash].editor
  const numberLanguage = editor[language]?.main === editor.en?.main ? 'en' : language
  description = doMath(description, numberLanguage)

  return {
    preparedDescription: removeUnusedText(description.trim()),
    titles: {
      ...titles,
      ...extractTitles(database[3].editor[language]?.main),
      ...extractTitles(database[3].editor[language]?.secondary)
    }
  }
}

export const convertDescription = (descriptionData: DescriptionData) => {
  // Keep legacy self/secondary import semantics, then resolve native nodes without flattening
  // their arms into new variable or math syntax. Ordinary documents retain their exact old path.
  const imported = loadExports(descriptionData)
  const native = nativeDescription(descriptionData, imported)
  if (native !== undefined) return { lines: native, native: true }
  const { preparedDescription, titles } = prepareDescription(descriptionData, imported)

  const convertedTitles = Object.entries(titles || {}).reduce<{ [key: string]: DescriptionLine[] }>(
    (acc, [titleName, titleContent]) => {
      const { preparedDescription } = prepareDescription({ ...descriptionData, descriptionString: titleContent })

      const convertedTitles = separateTableWeaponType(preparedDescription, {})
      if (convertedTitles) acc[titleName] = convertedTitles
      return acc
    },
    {}
  )

  return { lines: separateTableWeaponType(preparedDescription, convertedTitles), native: false }
}

export const descriptionConverter = (descriptionData: DescriptionData) => convertDescription(descriptionData).lines
