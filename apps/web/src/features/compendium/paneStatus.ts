import { create } from 'zustand';

/**
 * What the Editor's Compendium pane knows about the open tooltip, for the pane's tab. A phone shows
 * one panel at a time, so matched text is only discoverable through this dot.
 */
export type PaneStatus = 'matched' | 'review';
interface PaneStatusState {
  hash?: number;
  status?: PaneStatus;
  set(hash: number | undefined, status: PaneStatus | undefined): void;
}
export const usePaneStatus = create<PaneStatusState>((set) => ({
  set: (hash, status) =>
    set((state) => (state.hash === hash && state.status === status ? state : { hash, status })),
}));

/** The pane's status for `hash`, undefined while another tooltip owns it. */
export function useCompendiumDot(hash: number): PaneStatus | undefined {
  return usePaneStatus((state) => (state.hash === hash ? state.status : undefined));
}
