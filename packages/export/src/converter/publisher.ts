// databaseConverter from the held converter's examples/publisher.ts (the publisher's index.ts), with
// lodash replaced by plain loops and the command-line part moved to ../legacy.ts. The output must
// stay byte-identical to the held converter, so the order of every step is kept.
import {
  DescriptionData,
  IntermediatePerks,
  Languages,
  LiveAlias,
  LivePerk,
  descriptionConverter,
  descriptionFilter,
  expandAliases,
  getAliasOutput,
  getDataFromPerk,
  getSettings,
  isAliasStub,
  validateOutputReferences,
  validateReferences
} from './index.js'
import { cleanObject } from './helpers.js'

/** Hashes whose English text is the same as Bungie's own description, see bungieIdentical in ../legacy.ts */
export type IdenticalHashes = { has(hash: string): boolean }

export const databaseConverter = (converterType: string, database: IntermediatePerks, identical: IdenticalHashes) => {
  const settings = getSettings(converterType)
  validateReferences(database)
  // alias stubs become full copies of their original, used for every lookup and for the checks below
  const lookup = expandAliases(database)
  const references: { [hash: string]: LiveAlias } = {}

  const newDatabase: { [key: string]: LivePerk } = {}
  for (const [hash, rawPerk] of Object.entries(database)) {
    const aliasOutput = isAliasStub(rawPerk) ? getAliasOutput(settings, rawPerk) : 'copy'
    const perk = lookup[hash]
    // 'skip' is a sandbox alias of a legacy setting, no perk means the alias points at a missing perk
    if (aliasOutput === 'skip' || perk === undefined) continue

    // first 50 are reserved for internal use only
    if (Number(hash) < 50) continue

    const editorDescription = perk.editor.en?.main.trim() || ''
    // remove perks with out description
    if (editorDescription === '') continue
    // remove perks with bungie description
    if (!settings.optional && identical.has(hash)) continue

    // kept for after the loop, the original may not be output
    if (isAliasStub(rawPerk) && aliasOutput === 'reference') {
      references[hash] = { hash: rawPerk.hash, aliasOf: rawPerk.aliasOf }
      continue
    }

    const cleanPerk = getDataFromPerk(perk, settings.getFromPerk)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const descriptions = Object.entries(cleanPerk.editor).reduce<{ [key: string]: any }>(
      (acc, [language, descriptions]) => {
        const descriptionData: DescriptionData = {
          database: lookup,
          descriptionString: descriptions[settings.editor],
          editorType: settings.editor,
          hash: cleanPerk.hash as number,
          language: language as Languages
        }
        const convertedDescription = descriptionConverter(descriptionData)
        if (convertedDescription) {
          acc[language] = descriptionFilter(convertedDescription, converterType)
        }
        return acc
      },
      {}
    )

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { editor, ...withoutEditor } = cleanPerk
    newDatabase[hash] = {
      ...(withoutEditor as unknown as LivePerk),
      descriptions
    }
  }

  // a reference is only useful if the original is part of the same output, otherwise nothing can be looked up
  for (const [hash, reference] of Object.entries(references)) {
    if (newDatabase[reference.aliasOf] !== undefined) newDatabase[hash] = reference as unknown as LivePerk
  }

  const output = cleanObject(newDatabase)
  validateOutputReferences(output)
  return output
}
