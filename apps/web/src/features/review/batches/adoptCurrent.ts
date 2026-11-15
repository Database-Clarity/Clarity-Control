/**
 * Current saved as the Worker last showed it, adopted by the editor (code review round 1): a
 * resolve writes the tooltip to current, and a rebase or resolve refusal returns current at the
 * head it read. Both replace the editor's current saved tooltip and enter the saved overlay (so a
 * bundle reload that predates them cannot bring the old one back), as a normal save does
 * (services/save/drafts acceptSaved). Drafts are not touched.
 */
import type { Tooltip } from '@clarity/core';
import { BatchRefusal } from '../../../services/scheduled/api';
import { useDataStore } from '../../../stores/data';
import { rememberSaved } from '../../../stores/savedOverlay';

/** `tooltip` null: the tooltip is absent from current. `commit`: the write that made it so. */
export function adoptCurrent(hash: number, tooltip: Tooltip | null, commit?: string): void {
  rememberSaved(tooltip ? [tooltip] : [], tooltip ? [] : [hash]);
  useDataStore.setState(({ data }) => {
    if (!data) return {};
    const tooltips = { ...data.bundle.tooltips };
    if (tooltip) tooltips[hash] = tooltip;
    else delete tooltips[hash];
    return {
      data: {
        ...data,
        bundle: { ...data.bundle, sourceCommit: commit ?? data.bundle.sourceCommit, tooltips },
      },
    };
  });
}

/** Adopts the current a refusal carries; true when it carried one (old choices are void). */
export function adoptRefusalCurrent(hash: number, error: unknown): boolean {
  if (!(error instanceof BatchRefusal) || error.current === undefined) return false;
  adoptCurrent(hash, error.current);
  return true;
}
