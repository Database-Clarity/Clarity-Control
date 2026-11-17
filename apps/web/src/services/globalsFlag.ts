/**
 * Per-entry globals (variables and titles as stable-ID entries) stay off until the owner-gated
 * G1 storage migration, G2 install, and G3 activation. Off, every route, finder link, and save
 * path behaves exactly as before.
 */
export const globalsEnabled = import.meta.env.VITE_GLOBALS_ENABLED === '1';

/** The variables (2) and titles (3) aggregates: with globals on, only per-entry routes write them. */
export const globalAggregates: readonly number[] = [2, 3];

export const globalAggregateRefusal =
  'Variables and titles are saved per entry in Globals. Discard these drafts or copy them into the global entry.';

/** Refuses a raw aggregate write before any request leaves the browser (the Worker refuses too). */
export function assertNoGlobalAggregates(hashes: Iterable<number>, enabled = globalsEnabled): void {
  if (!enabled) return;
  for (const hash of hashes)
    if (globalAggregates.includes(hash)) throw new Error(globalAggregateRefusal);
}
