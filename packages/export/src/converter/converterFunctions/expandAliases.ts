import { DescriptionFilter } from '../converterSettings.js'
import { AliasStub, ExpandedPerks, IntermediatePerk, IntermediatePerks } from '../types.js'

const factNames = ['name', 'type', 'itemHash', 'itemName'] as const

export const isAliasStub = (perk: IntermediatePerk | AliasStub): perk is AliasStub => 'aliasOf' in perk

/**
 * Replaces every alias stub with a full copy of the perk it points at, with the hash of the alias.
 * If the stub has its own facts (name, type, itemHash, itemName) they replace the copied ones.
 * Stubs pointing at a perk that is missing, or that is a stub itself, are left out. Does not throw
 * Input is not modified, perks that are not aliases are returned as they are
 */
export const expandAliases = (perks: IntermediatePerks): ExpandedPerks => {
  const expanded: ExpandedPerks = {}

  for (const [hash, perk] of Object.entries(perks)) {
    if (!isAliasStub(perk)) {
      expanded[hash] = perk
      continue
    }

    const original = perks[perk.aliasOf]
    if (!original || isAliasStub(original)) continue

    const copy: IntermediatePerk = { ...original, hash: perk.hash }
    const facts = factNames.filter((fact) => perk[fact] !== undefined)
    if (facts.length > 0) {
      for (const fact of factNames) delete (copy as Partial<IntermediatePerk>)[fact]
      Object.assign(copy, ...facts.map((fact) => ({ [fact]: perk[fact] })))
    }
    expanded[hash] = copy
  }

  return expanded
}

/**
 * What to do with an alias for the given settings
 * 'copy' output the expanded copy, 'reference' output { hash, aliasOf }, 'skip' output nothing
 * A reference must only be output if the perk it points at is output as well, see examples/publisher.ts
 */
export const getAliasOutput = (settings: DescriptionFilter, stub: AliasStub): 'copy' | 'reference' | 'skip' => {
  if (settings.aliases === 'reference') return 'reference'
  return stub.aliasKind === 'frame' ? 'copy' : 'skip'
}
