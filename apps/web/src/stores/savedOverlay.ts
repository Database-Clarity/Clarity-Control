import { stableStringify, type Tooltip } from '@clarity/core';
import type { Bundle } from '../services/bundle';

/**
 * Tab memory of tooltips this tab saved. bundle.json is rebuilt by CI and cached by the CDN, so a
 * reload shortly after a save/push can return pre-save text. load() applies this overlay on top
 * of the fetched bundle until the fetched copy has caught up (identical or demonstrably newer) or the entry is older
 * than the TTL, so newer edits by other people still show up. A full page reload clears it.
 */
export const overlayTtlMs = 15 * 60 * 1000;
// With no server time, preserve the legacy browser-clock fallback and its five-minute margin.
export const overlayClockSkewMs = 5 * 60 * 1000;
// Builds currently stamp completion rather than the source snapshot time. Keep the existing
// five-minute allowance for delayed pre-save builds, even with server time; shrinking it
// needs source-time stamping first. Server time still removes browser skew from retirement.
export const overlayServerSkewMs = overlayClockSkewMs;
type Entry = { at: number; serverAt?: number; tooltip: Tooltip | null }; // null = deleted
const entries = new Map<number, Entry>();

export function rememberSaved(
  tooltips: Tooltip[],
  deleted: number[] = [],
  now = Date.now(),
  serverAt?: number,
): void {
  // Broken epoch/ancient timestamps must not retire a fresh save immediately. A day allows
  // substantial browser skew; unusable server times retain the legacy browser-clock fallback.
  serverAt =
    serverAt !== undefined &&
    Number.isFinite(serverAt) &&
    serverAt > 0 &&
    serverAt >= now - 24 * 60 * 60 * 1000
      ? serverAt
      : undefined;
  for (const tooltip of tooltips) entries.set(tooltip.hash, { at: now, serverAt, tooltip });
  for (const hash of deleted) entries.set(hash, { at: now, serverAt, tooltip: null });
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
    const newer =
      generatedAt >
      (entry.serverAt === undefined
        ? entry.at + overlayClockSkewMs
        : entry.serverAt + overlayServerSkewMs);
    if (caughtUp || newer || now - entry.at > overlayTtlMs) {
      entries.delete(hash);
      continue;
    }
    if (tooltips === bundle.tooltips) tooltips = { ...bundle.tooltips };
    if (entry.tooltip) tooltips[hash] = entry.tooltip;
    else delete tooltips[hash];
  }
  return tooltips === bundle.tooltips ? bundle : { ...bundle, tooltips };
}
