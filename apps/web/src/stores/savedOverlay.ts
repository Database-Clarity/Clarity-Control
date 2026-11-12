import { stableStringify, type Tooltip } from '@clarity/core';
import type { Bundle } from '../services/bundle';

/**
 * Tab memory of tooltips this tab saved. bundle.json is rebuilt by CI and cached by the CDN, so a
 * reload shortly after a save/push can return pre-save text. load() applies this overlay on top
 * of the fetched bundle until the fetched copy has caught up (identical or demonstrably newer) or the entry is older
 * than the TTL, so newer edits by other people still show up. A full page reload clears it.
 */
export const overlayTtlMs = 15 * 60 * 1000;
// Allow five minutes for browser/CI clock differences before trusting bundle chronology.
// This remains a heuristic: larger clock skew or delayed builds of older commits can retire
// entries too early. Server-provided save times are a follow-up once the save pipeline settles.
export const overlayClockSkewMs = 5 * 60 * 1000;
type Entry = { at: number; tooltip: Tooltip | null }; // null = deleted
const entries = new Map<number, Entry>();

export function rememberSaved(tooltips: Tooltip[], deleted: number[] = [], now = Date.now()): void {
  for (const tooltip of tooltips) entries.set(tooltip.hash, { at: now, tooltip });
  for (const hash of deleted) entries.set(hash, { at: now, tooltip: null });
}

export function clearSavedOverlay(): void {
  entries.clear();
}

export function applySavedOverlay(bundle: Bundle, now = Date.now()): Bundle {
  const generatedAt = Date.parse(bundle.generatedAt);
  let tooltips = bundle.tooltips;
  for (const [hash, entry] of [...entries]) {
    const fetched = bundle.tooltips[hash];
    const caughtUp = entry.tooltip
      ? fetched !== undefined && stableStringify(fetched) === stableStringify(entry.tooltip)
      : fetched === undefined;
    if (caughtUp || generatedAt > entry.at + overlayClockSkewMs || now - entry.at > overlayTtlMs) {
      entries.delete(hash);
      continue;
    }
    if (tooltips === bundle.tooltips) tooltips = { ...bundle.tooltips };
    if (entry.tooltip) tooltips[hash] = entry.tooltip;
    else delete tooltips[hash];
  }
  return tooltips === bundle.tooltips ? bundle : { ...bundle, tooltips };
}
