import { create } from 'zustand';

/**
 * The last save outcome ("Saved 3 tooltip(s)…", "…you switched accounts"). It lives here, not in
 * a popover's local state, so closing the drafts popover never loses it.
 */
export const useSaveNotice = create<{
  notice: string | null;
  show(message: string): void;
  dismiss(): void;
}>((set) => ({
  notice: null,
  show: (notice) => set({ notice }),
  dismiss: () => set({ notice: null }),
}));
