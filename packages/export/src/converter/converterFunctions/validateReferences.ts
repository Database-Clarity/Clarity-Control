import { LiveAlias, LivePerk } from '../livePerkTypes.js'
import { IntermediatePerks } from '../types.js'
import { isAliasStub } from './expandAliases.js'

export const validateReferences = (database: IntermediatePerks): void => {
  for (const hash of [1, 2, 3]) {
    const perk = database[hash]
    if (!perk || isAliasStub(perk)) throw new Error(`Missing canonical reserved global ${hash}`)
  }

  for (const [hash, perk] of Object.entries(database)) {
    if (isAliasStub(perk)) {
      const target = database[perk.aliasOf]
      if (!target || isAliasStub(target)) {
        throw new Error(`Invalid alias ${hash} -> ${perk.aliasOf}: target must be an existing canonical perk`)
      }
      continue
    }

    for (const associated of perk.associated || []) {
      const target = database[associated]
      if (!target || isAliasStub(target) || associated === perk.hash) {
        throw new Error(`Invalid association ${hash} -> ${associated}: target must be another existing canonical perk`)
      }
    }
  }
}

export const validateOutputReferences = (database: Record<string, LivePerk | LiveAlias>): void => {
  for (const [hash, perk] of Object.entries(database)) {
    const targets = 'aliasOf' in perk ? [perk.aliasOf] : perk.associated || []
    for (const targetHash of targets) {
      const target = database[targetHash]
      if (!target || 'aliasOf' in target || !target.descriptions) {
        throw new Error(`Invalid output reference ${hash} -> ${targetHash}: canonical target was filtered out`)
      }
    }
  }
}
