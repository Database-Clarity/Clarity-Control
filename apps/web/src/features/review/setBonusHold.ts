import { isSetBonusType, setBonusHoldMessage } from '@clarity/core';

/**
 * Set bonuses wait for cut-over (owner 2026-11-11, "Hold until cut-over"): they stay in the review
 * queue as saved changes, but are never selectable or pushed. The Worker refuses them as well.
 */
export const heldSetBonus = (categoryId: string): { unpublishable?: string } =>
  isSetBonusType(categoryId) ? { unpublishable: `${setBonusHoldMessage}.` } : {};
