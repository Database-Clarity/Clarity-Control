import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { reviewSaveChanges } from './state';

/** Opens the "Review save" dialog for the current local drafts (shared by the dock and Compendium). */
export function openDraftSaveReview(): void {
  const data = useDataStore.getState().data;
  if (!data) return;
  const submitted = useDraftStore.getState().drafts;
  reviewSaveChanges(
    Object.values(submitted).map(({ base, next }) => ({
      hash: next.hash,
      base: data.bundle.tooltips[next.hash] ? base : null,
      next,
    })),
    submitted,
  );
}
