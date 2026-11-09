import { create } from 'zustand';

/** How many saved changes are only alias-marker leftovers, for the sidebar's footer link. */
interface MarkerQueue {
  count: number;
  set(count: number): void;
}
export const useMarkerQueue = create<MarkerQueue>((set) => ({
  count: 0,
  set: (count) => set((state) => (state.count === count ? state : { count })),
}));
