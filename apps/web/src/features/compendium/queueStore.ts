import { create } from 'zustand';
import type { CategoryInfo, QueueModel } from './queueView';
import type { QueueCounts, QueueRow } from './queueRows';

/**
 * What the Compendium tab publishes for the shell's left column. The queue list lives outside the
 * routed page (Layout renders it), so the page hands it the rows; selection travels in the URL.
 */
interface QueueState {
  /** null until the review model is ready. */
  rows: QueueRow[] | null;
  counts: QueueCounts;
  categories: ReadonlyMap<string, CategoryInfo>;
  error?: string;
  /** The filtered list model (headers, rows, stepping order) the left column renders. */
  model: QueueModel;
  /** Groups flipped from their default (open, except the set-aside ones, which start closed). */
  toggled: ReadonlySet<string>;
  toggleGroup(group: string): void;
  /** The selected entry, for highlighting. */
  selected?: number;
  /** Put an excluded or unmatched entry back in the queue; undefined before the model is ready. */
  reinclude?: (row: QueueRow) => void;
  publish(state: Partial<Omit<QueueState, 'publish'>>): void;
}

export const emptyCounts: QueueCounts = {
  open: 0,
  matched: 0,
  noMatch: 0,
  notNeeded: 0,
  decided: 0,
};
export const useCompendiumQueueStore = create<QueueState>((set) => ({
  rows: null,
  counts: emptyCounts,
  categories: new Map(),
  model: { items: [], steps: [], visible: 0 },
  toggled: new Set(),
  toggleGroup: (group) =>
    set(({ toggled }) => {
      const next = new Set(toggled);
      if (!next.delete(group)) next.add(group);
      return { toggled: next };
    }),
  publish: (state) => set(state),
}));
