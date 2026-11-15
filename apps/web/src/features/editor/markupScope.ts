import type { MarkupGlobals } from '@clarity/core';

/** Insertion scope only: existing markup always keeps its parser and rendering semantics. */
export type ScopedMarkupGlobals = MarkupGlobals & { allowBaseEnhanced?: boolean };

export function offersBaseEnhanced(globals: MarkupGlobals): boolean {
  return (globals as ScopedMarkupGlobals).allowBaseEnhanced === true;
}

/**
 * Options offered only where `{{base}{enhanced}}` is: the pair itself and everything that writes
 * the enhanced arrow (owner 2026-11-14 "enhanced arrows should also only be available on perks
 * where the base/enhanced markup is available").
 */
export const baseEnhancedOnly: ReadonlySet<string> = new Set([
  'base-enhanced-pair',
  'enhanced-arrow',
  'enhanced-formula',
  'enhanced-block',
]);

/** Whether the option `id` (an entry or snippet id) is offered with these globals. */
export function offeredHere(id: string, globals: MarkupGlobals): boolean {
  return !baseEnhancedOnly.has(id) || offersBaseEnhanced(globals);
}
