// Armour set bonuses in the legacy files (owner 2026-11-11, "Set bonuses should definitely be added
// to legacy outputs"). A set bonus is an ordinary tooltip keyed by its sandbox perk hash, so the
// held converter code already writes it; this file only changes what the legacy files call it and
// which Bungie text counts as "the same as Bungie's". Every other entry is untouched.
import { isSetBonusType, setBonusLegacyType } from '@clarity/core/setBonus';
import type { IntermediatePerks } from './converter/index.js';

/**
 * The perks with each set bonus's `type` (the generator category id `armor-set-bonus`) renamed to
 * the legacy type name `Armor Set Bonus`. Returns the same object when there is none.
 */
export function withSetBonusType(perks: IntermediatePerks): IntermediatePerks {
  let renamed: IntermediatePerks | undefined;
  for (const [hash, perk] of Object.entries(perks)) {
    const type = (perk as { type?: unknown }).type;
    if (type === setBonusLegacyType || !isSetBonusType(type)) continue;
    renamed ??= { ...perks };
    renamed[hash] = { ...perk, type: setBonusLegacyType } as unknown as IntermediatePerks[string];
  }
  return renamed ?? perks;
}

export const isSetBonusPerk = (perk: { type?: unknown } | undefined) => isSetBonusType(perk?.type);
