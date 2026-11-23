import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { draftSaveStatus, reviewSaveChanges, useSaveState } from './state';

/** Opens the "Review save" dialog for the current local drafts (shared by the dock and Compendium). */
export function openDraftSaveReview(): void {
  const data = useDataStore.getState().data;
  if (!data) return;
  const drafts = useDraftStore.getState();
  const state = useSaveState.getState();
  const status = draftSaveStatus(drafts, state);
  if (status === 'Checking save') return;
  const submitted =
    status === 'Applying'
      ? Object.fromEntries(
          Object.entries(drafts.drafts).filter(([hash]) => !state.applyingDrafts[hash]),
        )
      : drafts.drafts;
  if (!Object.keys(submitted).length) return;
  reviewSaveChanges(
    Object.values(submitted).map(({ base, next }) => ({
      hash: next.hash,
      base: data.bundle.tooltips[next.hash] ? base : null,
      next,
    })),
    submitted,
  );
}
