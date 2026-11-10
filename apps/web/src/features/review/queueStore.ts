import { create } from 'zustand';
import type { PendingTooltip } from './model';
import { markerGroup } from './queueModel';

/**
 * Review state shared by the left-column queue and the page: the pending entries, what is
 * selected for the publish, and which groups are collapsed (component state, not the URL).
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
  openMarkers(): void;
}

const empty: ReadonlySet<never> = new Set();

export const useReviewQueue = create<ReviewQueueState>((set) => ({
  entries: null,
  selected: empty,
  collapsed: empty,
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
      return { collapsed: next };
    }),
  openMarkers: () => set((state) => (state.markerOpen ? state : { markerOpen: true })),
}));
