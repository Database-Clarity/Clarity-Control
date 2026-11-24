import { stableStringify, type AliasGroups, type GlobalRecord, type Tooltip } from '@clarity/core';
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
let version = 0;

/** Changes whenever a save is remembered or the overlay is cleared (see load() in data.ts). */
export function savedOverlayVersion(): number {
  return version;
}

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
  version++;
}

/** Global entries this tab saved, with the data head each save produced. */
type GlobalEntry = { at: number; head: string; entry: GlobalRecord };
const globals = new Map<string, GlobalEntry>();

export function rememberSavedGlobal(entry: GlobalRecord, head: string, now = Date.now()): void {
  globals.set(entry.id, { at: now, head, entry });
}

/** Globals this tab saved that the loaded bundle does not hold yet. */
export function savedGlobalsAhead(bundle: Bundle): ReadonlySet<string> {
  applySavedGlobals(bundle, bundle.globals?.entries ?? []);
  return new Set(globals.keys());
}

/** The alias groups after this tab's removals, until the bundle lists those members as removed. */
let groups: { at: number; head: string; config: AliasGroups; members: number[] } | undefined;

export function rememberSavedAliasGroups(
  config: AliasGroups,
  head: string,
  member: number,
  now = Date.now(),
): void {
  groups = { at: now, head, config, members: [...(groups?.members ?? []), member] };
  version++;
}

export function clearSavedOverlay(): void {
  entries.clear();
  globals.clear();
  groups = undefined;
  version++;
}

/** The fetched bundle has caught up, or is demonstrably newer than the save, or the save is old. */
function retired(
  entry: { at: number; serverAt?: number },
  generatedAt: number,
  caughtUp: boolean,
  now: number,
) {
  const newer =
    generatedAt >
    (entry.serverAt === undefined
      ? entry.at + overlayClockSkewMs
      : entry.serverAt + overlayServerSkewMs);
  return caughtUp || newer || now - entry.at > overlayTtlMs;
}

/**
 * The bundle's globals catalogue with this tab's saved entries on top, until the bundle is built
 * from the saved head (or a later save of the same record shows), by the tooltip rule above.
 */
export function applySavedGlobals(
  bundle: Pick<Bundle, 'sourceCommit' | 'generatedAt'>,
  fetched: readonly GlobalRecord[],
  now = Date.now(),
): GlobalRecord[] {
  const generatedAt = Date.parse(bundle.generatedAt);
  const result = [...fetched];
  for (const [id, saved] of [...globals]) {
    const index = result.findIndex((entry) => entry.id === id);
    const current = index >= 0 ? result[index] : undefined;
    // Built from the saved head, holding the saved record, or a later rename of it.
    const caughtUp =
      bundle.sourceCommit === saved.head ||
      (current !== undefined &&
        (stableStringify(current) === stableStringify(saved.entry) ||
          current.nameHistory.some((old) => old.revision === saved.entry.revision)));
    if (retired(saved, generatedAt, caughtUp, now)) {
      globals.delete(id);
      continue;
    }
    if (index >= 0) result[index] = saved.entry;
    else result.push(saved.entry);
  }
  return result;
}

export function applySavedOverlay(bundle: Bundle, now = Date.now()): Bundle {
  const generatedAt = Date.parse(bundle.generatedAt);
  let tooltips = bundle.tooltips;
  for (const [hash, entry] of [...entries]) {
    const fetched = bundle.tooltips[hash];
    const caughtUp = entry.tooltip
      ? fetched !== undefined && stableStringify(fetched) === stableStringify(entry.tooltip)
      : fetched === undefined;
    if (retired(entry, generatedAt, caughtUp, now)) {
      entries.delete(hash);
      continue;
    }
    if (tooltips === bundle.tooltips) tooltips = { ...bundle.tooltips };
    if (entry.tooltip) tooltips[hash] = entry.tooltip;
    else delete tooltips[hash];
  }
  if (groups) {
    const caughtUp =
      bundle.sourceCommit === groups.head ||
      groups.members.every((member) => bundle.aliasGroups?.removed?.[member]);
    if (retired(groups, generatedAt, caughtUp, now)) groups = undefined;
  }
  if (!groups) return tooltips === bundle.tooltips ? bundle : { ...bundle, tooltips };
  // The removal commit also drops the members' publish markers.
  const pushed = { ...bundle.pushed };
  for (const member of groups.members) delete pushed[member];
  return { ...bundle, tooltips, pushed, aliasGroups: groups.config };
}
