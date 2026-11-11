/**
 * Armour set bonuses (owner 2026-11-11). Their tooltips are keyed by the sandbox perk hash and use
 * the generator's `armor-set-bonus` category. The 7 legacy files gain them only at cut-over, built
 * by the new converter with the legacy type name below, so until then they are held: editors write
 * and save them, but nothing pushes them live. Cut-over removes the hold hooks (`isHeldSetBonus`).
 */
export const setBonusCategoryId = 'armor-set-bonus';
/** The type name set bonuses have in the legacy files. */
export const setBonusLegacyType = 'Armor Set Bonus';
export const setBonusHoldMessage =
  'Set bonuses need the new converter; they can be pushed after cut-over';

/** A category id or legacy type (`type`, `categoryId`) that names a set bonus. */
export const isSetBonusType = (type: unknown): boolean =>
  type === setBonusCategoryId || type === setBonusLegacyType;

/**
 * Whether a tooltip is held back from pushing: its generator type (`facts.type`), or its custom
 * category when it has no generator entry, is a set bonus. Same precedence as `exportLegacy`.
 */
export const isHeldSetBonus = (
  tooltip: { custom?: { categoryId: string } },
  facts?: { type?: unknown },
): boolean => isSetBonusType(facts ? facts.type : tooltip.custom?.categoryId);
