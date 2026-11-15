import { create } from 'zustand';
import type { PendingTooltip } from './model';
import { markerGroup } from './queueModel';

/**
 * Review state shared by the left-column queue and the page: the pending entries, what is
 * selected for the publish, and which groups are collapsed (not the URL; remembered per device).
 */
interface ReviewQueueState {
  /** Every pending saved change, marker-only included; null until the first comparison. */
  entries: PendingTooltip[] | null;
  selected: ReadonlySet<number>;
  collapsed: ReadonlySet<string>;
  /** The marker-only group is collapsed by default. */
  markerOpen: boolean;
  /** The list's scroll position, kept across leaving and returning to the route. */
  scrollTop: number;
  setEntries(entries: PendingTooltip[]): void;
  toggle(hash: number): void;
  /** Adds every hash when any is missing, otherwise removes them all (a group's checkbox). */
  toggleAll(hashes: readonly number[]): void;
  clearSelection(): void;
  toggleGroup(id: string): void;
  /** Collapse all or Expand all: the given category groups, never the marker-only group. */
  setGroupsCollapsed(ids: readonly string[], collapsed: boolean): void;
  openMarkers(): void;
}

const empty: ReadonlySet<never> = new Set();

/** The collapsed category groups, remembered per device like the other view state. */
const collapsedKey = 'clarity-review-collapsed:v1';
function readCollapsed(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]');
    if (Array.isArray(value))
      return new Set(
        value.filter((id): id is string => typeof id === 'string' && id !== markerGroup),
      );
  } catch {
    // Unreadable or unavailable storage: every group starts open.
  }
  return empty;
}
function writeCollapsed(collapsed: ReadonlySet<string>) {
  try {
    if (collapsed.size) localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
    else localStorage.removeItem(collapsedKey);
  } catch {
    // Storage full or blocked: the choice still holds for this session.
  }
}

export const useReviewQueue = create<ReviewQueueState>((set) => ({
  entries: null,
  selected: empty,
  collapsed: readCollapsed(),
  markerOpen: false,
  scrollTop: 0,
  setEntries: (entries) => set((state) => (state.entries === entries ? state : { entries })),
  toggle: (hash) =>
    set((state) => {
      const next = new Set(state.selected);
      if (!next.delete(hash)) next.add(hash);
      return { selected: next };
    }),
  toggleAll: (hashes) =>
    set((state) => {
      const next = new Set(state.selected);
      if (hashes.every((hash) => next.has(hash))) for (const hash of hashes) next.delete(hash);
      else for (const hash of hashes) next.add(hash);
      return { selected: next };
    }),
  clearSelection: () => set((state) => (state.selected.size ? { selected: empty } : state)),
  toggleGroup: (id) =>
    set((state) => {
      if (id === markerGroup) return { markerOpen: !state.markerOpen };
      const next = new Set(state.collapsed);
      if (!next.delete(id)) next.add(id);
      writeCollapsed(next);
      return { collapsed: next };
    }),
  setGroupsCollapsed: (ids, collapsed) =>
    set((state) => {
      const next = new Set(state.collapsed);
      for (const id of ids)
        if (id !== markerGroup) {
          if (collapsed) next.add(id);
          else next.delete(id);
        }
      if (next.size === state.collapsed.size && [...next].every((id) => state.collapsed.has(id)))
        return state;
      writeCollapsed(next);
      return { collapsed: next };
    }),
  openMarkers: () => set((state) => (state.markerOpen ? state : { markerOpen: true })),
}));
