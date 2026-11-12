import { isHeldSetBonus, setBonusHoldMessage, type LegacyCatalog } from '@clarity/core';
import { HttpError } from './http.js';

/**
 * Set bonuses wait for cut-over (owner 2026-11-11, "Hold until cut-over"): refuse them before any
 * write. With `facts`, a generator set bonus is found by its category; without them (publish,
 * which reads no generator items), only a custom set bonus is, and the publisher refuses the rest.
 */
export function refuseHeldSetBonuses(
  tooltips: readonly { hash: number; custom?: { categoryId: string } }[],
  facts?: LegacyCatalog,
): void {
  for (const tooltip of tooltips) {
    if (isHeldSetBonus(tooltip, facts?.[tooltip.hash])) {
      throw new HttpError(422, setBonusHoldMessage);
    }
  }
}
