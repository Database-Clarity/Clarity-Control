import { create } from 'zustand';

/**
 * Whether the Reports tab is the open side view. One value for the session, so stepping to the
 * next tooltip keeps the tab (the concept's "no auto-switch"). `focusPending` asks the pane to
 * focus its list once it has reports (Alt+R, or arriving from the header entry); the pane may
 * mount after the request, so it is a flag the pane clears, not a counter it compares.
 */
interface TabState {
  open: boolean;
  focusToken: number;
  focusPending: boolean;
  setOpen(open: boolean): void;
  openAndFocus(): void;
  focusDone(): void;
}

export const useReportsTab = create<TabState>((set) => ({
  open: false,
  focusToken: 0,
  focusPending: false,
  setOpen(open) {
    set((state) => (state.open === open ? state : { open }));
  },
  openAndFocus() {
    set((state) => ({ open: true, focusToken: state.focusToken + 1, focusPending: true }));
  },
  focusDone() {
    set((state) => (state.focusPending ? { focusPending: false } : state));
  },
}));
