import { create } from 'zustand';

/** Whether the settings popover (phone: full-screen sheet) is open, and where /settings returns. */
export const useSettingsPanel = create<{
  open: boolean;
  /** The route /settings is replaced with: the last page the user was on. */
  returnTo: string;
  show(): void;
  hide(): void;
  remember(route: string): void;
}>((set) => ({
  open: false,
  returnTo: '/',
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  remember: (returnTo) => set({ returnTo }),
}));
