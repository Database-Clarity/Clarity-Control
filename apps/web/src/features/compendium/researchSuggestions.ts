import hints from './research-hints.json';
import { sourceFingerprint } from './reviewProgress';
import { categorySuggestions, type CompendiumSuggestion } from './suggestions';
import type { CompendiumData } from '@clarity/core';
interface Place {
  gid: string;
  rowKey?: string;
  section?: string;
  rationale: string;
  relation: string;
  fingerprint?: string;
}
interface Entry {
  name: string;
  category: string;
  places: number[];
}
const records: Record<string, Entry> = hints.entries;
const places: Place[] = hints.places;
const projections = new WeakMap<CompendiumData, Map<Place, CompendiumSuggestion>>();
// Navigation only. Resolve coordinates anew; normal picker validates human selections.
export function researchSuggestions(
  hash: number,
  data: CompendiumData,
  category: string,
  name: string,
): CompendiumSuggestion[] {
  const entry = records[hash];
  if (!entry || entry.name !== name || entry.category !== category)
    return categorySuggestions(data, category, name);
  return entry.places.map((index) => {
    const result = placeSuggestion(data, places[index]);
    // Callers receive their own mutable navigation result, not the cached proof.
    return { ...result, ...(result.anchor ? { anchor: { ...result.anchor } } : {}) };
  });
}

function placeSuggestion(data: CompendiumData, place: Place): CompendiumSuggestion {
  let cached = projections.get(data);
  if (!cached) projections.set(data, (cached = new Map()));
  const previous = cached.get(place);
  if (previous) return previous;
  const tab = data.tabs.find((tab) => tab.gid === place.gid);
  const anchors = tab?.grid?.filter((c) => c.cell.plain.trim() === place.rowKey?.trim()) ?? [];
  const anchor = anchors.length === 1 ? anchors[0] : undefined;
  const fingerprint =
    anchor &&
    place.fingerprint &&
    sourceFingerprint(
      tab!
        .grid!.filter((c) => Math.abs(c.row - anchor.row) <= 8)
        .map((c) => ({ dRow: c.row - anchor.row, col: c.col, cell: c.cell })),
    );
  const stale =
    !!place.rowKey && (!anchor || !place.fingerprint || fingerprint !== place.fingerprint);
  const section = anchor
    ? tab?.rows.find((row) => row.anchor?.row === anchor.row && row.anchor?.col === anchor.col)
        ?.section
    : tab?.rows.some((row) => row.section === place.section)
      ? place.section
      : undefined;
  const result = {
    gid: place.gid,
    section,
    ...(anchor ? { anchor: { row: anchor.row, col: anchor.col } } : {}),
    rationale: `${place.relation === 'equivalent' ? 'Whole source proposal; confirm scope' : place.relation}. ${place.rationale} Observed ${hints.observedAt}. ${stale ? 'Warning: source window changed or anchor is missing/ambiguous; review this proposal again.' : 'Navigation evidence only; no link is accepted.'}${!section ? ' Specific section unknown; full search remains available.' : ''}`,
    observedAt: hints.observedAt,
    fingerprint: place.fingerprint,
    stale,
  };
  cached.set(place, result);
  return result;
}

/** Validate all dated navigation places once per immutable source revision. */
export function warmResearchSuggestions(data: CompendiumData) {
  if (projections.get(data)?.size === places.length) return () => {};
  let cancelled = false,
    index = 0,
    idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController(),
    started = performance.now();
  let maxUnitMs = 0;
  const inputPending = () =>
    (
      globalThis.navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    )?.scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  const tasks = (
    globalThis as typeof globalThis & {
      scheduler?: {
        postTask(
          callback: () => void,
          options: { priority: 'background'; signal: AbortSignal },
        ): Promise<unknown>;
      };
    }
  ).scheduler;
  function waitIdle() {
    if (cancelled) return;
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(step);
    else timer = setTimeout(() => step(), 16);
  }
  function schedule() {
    if (cancelled) return;
    if (tasks && !inputPending())
      void tasks
        .postTask(() => step(), { priority: 'background', signal: controller.signal })
        .catch(waitIdle);
    else waitIdle();
  }
  function step(deadline?: IdleDeadline) {
    if (cancelled) return;
    if (inputPending() || (deadline && deadline.timeRemaining() < 4)) {
      waitIdle();
      return;
    }
    // One source window per task. Foreground calls remain synchronous and correct
    // if input arrives before this optional preparation has reached that place.
    const at = performance.now();
    placeSuggestion(data, places[index++]);
    maxUnitMs = Math.max(maxUnitMs, performance.now() - at);
    if (index < places.length) schedule();
    else
      performance.mark('compendium:research-prepared', {
        detail: { maxUnitMs, durationMs: performance.now() - started, places: places.length },
      });
  }
  schedule();
  return () => {
    cancelled = true;
    controller.abort();
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}
