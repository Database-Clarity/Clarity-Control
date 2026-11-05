import { create } from 'zustand';

export interface SidebarCategory {
  id: string;
  name: string;
  /** Optional normalized destination supplied by the Compendium review queue. */
  entryTarget?: string;
}

export interface SidebarPendingChange {
  hash: number;
  name: string;
  category: string;
}

interface SidebarQueueState {
  compendiumCategories: SidebarCategory[] | null;
  pendingChanges: SidebarPendingChange[] | null;
  setCompendiumCategories(categories: SidebarCategory[]): void;
  setPendingChanges(changes: SidebarPendingChange[]): void;
}

export const useSidebarQueueStore = create<SidebarQueueState>((set) => ({
  compendiumCategories: null,
  pendingChanges: null,
  setCompendiumCategories: (compendiumCategories) => set({ compendiumCategories }),
  setPendingChanges: (pendingChanges) => set({ pendingChanges }),
}));
