import { useEffect } from 'react';
import { usePreviewReviewStore } from '../../stores/previewReview';

/**
 * Call from the component that renders a tooltip variant's preview. While `visible` is true, every
 * commit that rendered the variant at the store's current revision marks that revision as seen
 * (an expansion click alone never does). An edit made later bumps the revision and re-arms the guard.
 */
export function useAcknowledgePreview(variant: number, visible: boolean) {
  const revision = usePreviewReviewStore((state) => state.entries[variant]?.dirty ?? 0);
  useEffect(() => {
    if (visible && revision > 0) usePreviewReviewStore.getState().acknowledge(variant, revision);
  }, [variant, visible, revision]);
}
