import { create } from 'zustand';

export interface SidebarPendingChange {
  hash: number;
  name: string;
  category: string;
}

interface SidebarQueueState {
  pendingChanges: SidebarPendingChange[] | null;
  setPendingChanges(changes: SidebarPendingChange[]): void;
}

export const useSidebarQueueStore = create<SidebarQueueState>((set) => ({
  pendingChanges: null,
  setPendingChanges: (pendingChanges) => set({ pendingChanges }),
}));
