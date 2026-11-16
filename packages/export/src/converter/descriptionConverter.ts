import { doMath } from './converterFunctions/math.js'
import { extractTitles } from './converterFunctions/extractTitles.js'
import { loadExports } from './converterFunctions/loadExports.js'
import { loadVariables } from './converterFunctions/loadVariables.js'
import { removePerkSpecificText } from './converterFunctions/removePerkSpecificText.js'
import { removeUnusedText } from './converterFunctions/removeUnusedText.js'
import { separateTableWeaponType } from './converterFunctions/separateTableWeaponType.js'
import { DescriptionData, DescriptionLine } from './types.js'
import { parseMarkup } from '@clarity/core/markup/parse'

// Only provenance-marked English fallbacks retain English number formatting.
const numberLanguage = ({ database, hash, language }: DescriptionData) =>
  database[hash].editor[language]?.englishFallback ? 'en' : language

/** Native inline nodes use the editor's real resolver, in the importing perk's context. */
const nativeDescription = (descriptionData: DescriptionData, description: string) => {
  const { database, hash, language } = descriptionData
  const library = (id: number) => {
    const text = database[id]?.editor[language]
    return [text?.main, text?.secondary].filter(Boolean).join('\n')
  }
  const variables = library(2)
  // parseMarkup resolves visible title imports, including pairs assembled by mid-line splices.
  const titles = library(3)
  let native = [description, variables, titles].some((source) => source.includes('{{'))
  // Variable substitution can introduce a later title import. Keep the real resolver's
  // context for those passes, and observe its reads instead of guessing the dependency graph.
  const imports = new Proxy(Object.create(null) as Record<string, string>, {
    get(_target, key) {
      const source = typeof key === 'string' ? database[key]?.editor[language]?.main : undefined
      // A late imported fragment can also complete a pair without containing a literal {{.
      if (source?.includes('{')) native = true
      return source
    }
  })
  const parsed = parseMarkup(description, {
    variables, titles, imports, type: database[hash].type,
    lang: numberLanguage(descriptionData)
  })
  if (!native) return undefined
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
  // Stale or unfreezable fallback text keeps English numbers; real translations use their
  // language even when resolving number tokens makes their text identical to English.
  description = doMath(description, numberLanguage(descriptionData))

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
  if (native !== undefined) return { lines: native.length ? native : undefined, native: true }
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
