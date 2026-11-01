import { merge3, stableStringify, type Tooltip } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import type { Drafts } from '../draftStorage';

export function replaceDraft(base: Tooltip, next: Tooltip, resetBase = false): void {
  if (base.hash !== next.hash) throw new Error('Cannot replace a draft with a different tooltip.');
  const state = useDraftStore.getState();
  if (!state.hydrated) throw new Error('Draft recovery must finish before editing.');
  const original = resetBase ? base : (state.drafts[base.hash]?.base ?? base);
  const drafts: Drafts = { ...state.drafts, [base.hash]: { base: original, next } };
  if (stableStringify(original) === stableStringify(next)) delete drafts[base.hash];
  useDraftStore.setState({ drafts });
  state.retry();
}

export function acceptSaved(
  submitted: Drafts,
  tooltips: Tooltip[],
  commit?: string,
  deleted: number[] = [],
): void {
  const state = useDraftStore.getState();
  const drafts = { ...state.drafts };
  const saved = new Map(tooltips.map((tooltip) => [tooltip.hash, tooltip]));
  for (const [hash, draft] of Object.entries(submitted)) {
    const current = drafts[hash];
    const head = saved.get(Number(hash));
    if (!head && !deleted.includes(Number(hash)))
      throw new Error(`Save response omitted tooltip ${hash}; drafts were retained.`);
    if (!current) continue;
    if (stableStringify(current) === stableStringify(draft)) delete drafts[hash];
    else if (head) {
      const merged = merge3(draft.next, head, current.next);
      if (merged.ok) drafts[hash] = { base: head, next: merged.merged };
    }
  }
  useDataStore.setState(({ data }) => {
    if (!data) throw new Error('Editor data disappeared during save.');
    const tooltips = { ...data.bundle.tooltips, ...Object.fromEntries(saved) };
    for (const hash of deleted) delete tooltips[hash];
    return {
      data: {
        ...data,
        bundle: {
          ...data.bundle,
          sourceCommit: commit ?? data.bundle.sourceCommit,
          tooltips,
        },
      },
    };
  });
  useDraftStore.setState({ drafts });
  state.retry();
}
