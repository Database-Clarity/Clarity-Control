import { isMovedInactive, type InactiveMoves } from '@clarity/core';
import type { ItemClassification } from './itemClassification';

/** Kept separate while Enhanced mods owns the computed classification implementation. */
export function inactiveOverride(
  hash: number,
  moves?: InactiveMoves,
): ItemClassification | undefined {
  if (!isMovedInactive(hash, moves)) return;
  return {
    categoryId: 'inactive-placeholder',
    ruleId: 'maintainer-inactive',
    reason: 'Maintainer-moved to Inactive; text stays editable and leaves outputs when published.',
    excluded: true,
    origin: 'editor',
  };
}
