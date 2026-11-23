import { create } from 'zustand';
import { stableStringify } from '@clarity/core';
import { useDraftStore } from '../../stores/drafts';
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
  progress: SaveProgress;
  recoveryGeneration: number | null;
  applyingDrafts: Drafts;
  close(): void;
}>((set) => ({
  locked: false,
  review: null,
  progress: idleProgress,
  recoveryGeneration: null,
  applyingDrafts: {},
  close: () => set({ locked: false, review: null, progress: idleProgress }),
}));

export const useSaveProgress = () => useSaveState((state) => state.progress);

export function draftSaveStatus(
  { owner, generation }: Pick<ReturnType<typeof useDraftStore.getState>, 'owner' | 'generation'>,
  { recoveryGeneration, applyingDrafts }: ReturnType<typeof useSaveState.getState>,
) {
  if (!owner || typeof indexedDB === 'undefined') return null;
  if (recoveryGeneration !== generation) return 'Checking save';
  return Object.keys(applyingDrafts).length ? 'Applying' : null;
}

export function useDraftSaveStatus() {
  const owner = useDraftStore((state) => state.owner);
  const generation = useDraftStore((state) => state.generation);
  return useSaveState((state) => draftSaveStatus({ owner, generation }, state));
}

export function visibleDrafts(drafts: Drafts, applying: Drafts): Drafts {
  if (!Object.keys(applying).length) return drafts;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([hash, draft]) =>
        !applying[hash] || stableStringify(draft) !== stableStringify(applying[hash]),
    ),
  );
}

export function reviewSaveChanges(changes: Change[], submitted: Drafts = {}): void {
  if (useSaveState.getState().locked) throw new Error('Finish the open save review first.');
  if (!changes.length) throw new Error('There are no changes to save.');
  useSaveState.setState({ locked: true, review: { changes, submitted }, progress: idleProgress });
}
