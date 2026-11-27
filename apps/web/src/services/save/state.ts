import { create } from 'zustand';
import type { Change } from '../api';
import type { Drafts } from '../draftStorage';

export interface SaveReview {
  changes: Change[];
  submitted: Drafts;
}

export interface SaveProgress {
  phase: 'idle' | 'saving' | 'staging' | 'landing' | 'failed';
  done: number;
  total: number;
  failed: string | null;
}

const idleProgress: SaveProgress = { phase: 'idle', done: 0, total: 0, failed: null };

export const useSaveState = create<{
  locked: boolean;
  review: SaveReview | null;
  session: number;
  visitingTooltip: boolean;
  progress: SaveProgress;
  close(): void;
}>((set) => ({
  locked: false,
  review: null,
  session: 0,
  visitingTooltip: false,
  progress: idleProgress,
  close: () => set({ locked: false, review: null, visitingTooltip: false, progress: idleProgress }),
}));

export const useSaveProgress = () => useSaveState((state) => state.progress);

export function reviewSaveChanges(changes: Change[], submitted: Drafts = {}): void {
  if (useSaveState.getState().locked) throw new Error('Finish the open save review first.');
  if (!changes.length) throw new Error('There are no changes to save.');
  useSaveState.setState(({ session }) => ({
    locked: true,
    review: { changes, submitted },
    session: session + 1,
    visitingTooltip: false,
    progress: idleProgress,
  }));
}
