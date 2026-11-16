import { create } from 'zustand';
import type { PendingTooltip } from './model';
import { markerGroup, type Leftovers } from './queueModel';

/**
 * Review state shared by the left-column queue and the page: the pending entries, what is
 * selected for the publish, and which groups are collapsed (not the URL; remembered per device).
 */
interface ReviewQueueState {
  /** Every pending saved change, leftovers included; null until the first comparison. */
  entries: PendingTooltip[] | null;
  selected: ReadonlySet<number>;
  collapsed: ReadonlySet<string>;
  /** Migration leftovers are hidden until the list's "Show". */
  leftovers: Leftovers;
  /** The list's scroll position, kept across leaving and returning to the route. */
  scrollTop: number;
  setEntries(entries: PendingTooltip[]): void;
  toggle(hash: number): void;
  /** Sets one row's tick (Include / Remove and their Undo). */
  setIncluded(hash: number, included: boolean): void;
  /** Adds every hash when any is missing, otherwise removes them all (a group's checkbox). */
  toggleAll(hashes: readonly number[]): void;
  /** Adds every hash ("Include all N"). */
  includeAll(hashes: readonly number[]): void;
  clearSelection(): void;
  toggleGroup(id: string): void;
  showLeftovers(): void;
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
  leftovers: 'hidden',
  scrollTop: 0,
  setEntries: (entries) => set((state) => (state.entries === entries ? state : { entries })),
  toggle: (hash) =>
    set((state) => {
      const next = new Set(state.selected);
      if (!next.delete(hash)) next.add(hash);
      return { selected: next };
    }),
  setIncluded: (hash, included) =>
    set((state) => {
      if (state.selected.has(hash) === included) return state;
      const next = new Set(state.selected);
      if (included) next.add(hash);
      else next.delete(hash);
      return { selected: next };
    }),
  toggleAll: (hashes) =>
    set((state) => {
      const next = new Set(state.selected);
      if (hashes.every((hash) => next.has(hash))) for (const hash of hashes) next.delete(hash);
      else for (const hash of hashes) next.add(hash);
      return { selected: next };
    }),
  includeAll: (hashes) =>
    set((state) => {
      if (hashes.every((hash) => state.selected.has(hash))) return state;
      return { selected: new Set([...state.selected, ...hashes]) };
    }),
  clearSelection: () => set((state) => (state.selected.size ? { selected: empty } : state)),
  toggleGroup: (id) =>
    set((state) => {
      if (id === markerGroup)
        return { leftovers: state.leftovers === 'open' ? 'collapsed' : 'open' };
      const next = new Set(state.collapsed);
      if (!next.delete(id)) next.add(id);
      writeCollapsed(next);
      return { collapsed: next };
    }),
  showLeftovers: () =>
    set((state) => (state.leftovers === 'hidden' ? { leftovers: 'collapsed' } : state)),
}));
