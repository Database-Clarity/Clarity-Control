import { create } from 'zustand';

/**
 * The last save outcome ("Saved 3 tooltip(s)…", "…you switched accounts"). It lives here, not in
 * a popover's local state, so closing the drafts popover never loses it.
 */
export const useSaveNotice = create<{
  notice: string | null;
  /** The saved translation's Review row, for an account that publishes it there. */
  review: { key: string; lang: string } | null;
  show(message: string, review?: { key: string; lang: string }): void;
  dismiss(): void;
}>((set) => ({
  notice: null,
  review: null,
  show: (notice, review = undefined) => set({ notice, review: review ?? null }),
  dismiss: () => set({ notice: null, review: null }),
}));
