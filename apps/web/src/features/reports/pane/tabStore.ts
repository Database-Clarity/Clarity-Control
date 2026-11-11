import { create } from 'zustand';

/**
 * Whether the Reports tab is the open side view. One value for the session, so stepping to the
 * next tooltip keeps the tab (the concept's "no auto-switch"). `focusToken` asks the pane to
 * focus its first report (Alt+R, or arriving from the header entry).
 */
interface TabState {
  open: boolean;
  focusToken: number;
  setOpen(open: boolean): void;
  openAndFocus(): void;
}

export const useReportsTab = create<TabState>((set) => ({
  open: false,
  focusToken: 0,
  setOpen(open) {
    set((state) => (state.open === open ? state : { open }));
  },
  openAndFocus() {
    set((state) => ({ open: true, focusToken: state.focusToken + 1 }));
  },
}));
