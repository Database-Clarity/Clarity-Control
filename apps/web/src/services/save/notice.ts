import { create } from 'zustand';

/**
 * The last save outcome ("Saved 3 tooltip(s)…", "…you switched accounts"). It lives here, not in
 * a popover's local state, so closing the drafts popover never loses it.
 */
export const useSaveNotice = create<{
  notice: string | null;
  /** Where the saved translation waits in Review, for an account that publishes it there. */
  review: string | null;
  show(message: string, review?: string): void;
  dismiss(): void;
}>((set) => ({
  notice: null,
  review: null,
  show: (notice, review = undefined) => set({ notice, review: review ?? null }),
  dismiss: () => set({ notice: null, review: null }),
}));
