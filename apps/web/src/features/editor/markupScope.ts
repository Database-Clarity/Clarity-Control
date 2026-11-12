import type { MarkupGlobals } from '@clarity/core';

/** Insertion scope only: existing markup always keeps its parser and rendering semantics. */
export type ScopedMarkupGlobals = MarkupGlobals & { allowBaseEnhanced?: boolean };

export function offersBaseEnhanced(globals: MarkupGlobals): boolean {
  return (globals as ScopedMarkupGlobals).allowBaseEnhanced === true;
}
