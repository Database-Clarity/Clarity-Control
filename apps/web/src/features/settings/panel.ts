import { create } from 'zustand';

/** Whether the settings popover (phone: full-screen sheet) is open, and where /settings returns. */
export const useSettingsPanel = create<{
  open: boolean;
  /** The route /settings is replaced with: the last page the user was on. */
  returnTo: string;
  /** The stable button that opened Settings: its anchor and where focus returns on close. */
  opener: HTMLElement | null;
  show(opener?: HTMLElement | null): void;
  hide(): void;
  remember(route: string): void;
}>((set) => ({
  open: false,
  returnTo: '/',
  opener: null,
  show: (opener) => set({ open: true, opener: opener ?? null }),
  hide: () => set({ open: false, opener: null }),
  remember: (returnTo) => set({ returnTo }),
}));
