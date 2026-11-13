import { merge3, stableStringify, type Tooltip } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { rememberSaved } from '../../stores/savedOverlay';
import type { Drafts } from '../draftStorage';

/** The part of a draft store (Current or batch) that save reconciliation touches. */
export interface ReconciledStore {
  getState(): { hydrated: boolean; drafts: Drafts; retry(): void };
  setState(partial: { drafts: Drafts }): void;
}

export function replaceDraft(base: Tooltip, next: Tooltip, resetBase = false): void {
  replaceDraftAt(useDraftStore, String(base.hash), base, next, resetBase);
}

/** `replaceDraft` for any draft store and key (batch drafts: services/scheduled/batchDrafts.ts). */
export function replaceDraftAt(
  store: ReconciledStore,
  key: string,
  base: Tooltip,
  next: Tooltip,
  resetBase = false,
): void {
  if (base.hash !== next.hash) throw new Error('Cannot replace a draft with a different tooltip.');
  const state = store.getState();
  if (!state.hydrated) throw new Error('Draft recovery must finish before editing.');
  const original = resetBase ? base : (state.drafts[key]?.base ?? base);
  const drafts: Drafts = { ...state.drafts, [key]: { base: original, next } };
  if (stableStringify(original) === stableStringify(next)) delete drafts[key];
  store.setState({ drafts });
  state.retry();
}

/**
 * The drafts after a save of `submitted` came back: a submitted draft nobody changed meanwhile is
 * dropped; one edited during the save is rebased on the saved version (merge3, kept as is when
 * that conflicts). Only submitted keys are touched. `saved(key)` is the version the server stored
 * for that key; `gone(key)` says the save deleted it. A key with neither throws before anything
 * changes, so the drafts are retained.
 */
export function reconcileSaved(
  drafts: Drafts,
  submitted: Drafts,
  saved: (key: string) => Tooltip | undefined,
  gone: (key: string) => boolean = () => false,
): Drafts {
  const out = { ...drafts };
  for (const [key, draft] of Object.entries(submitted)) {
    const current = out[key];
    const head = saved(key);
    if (!head && !gone(key))
      throw new Error(`Save response omitted tooltip ${key}; drafts were retained.`);
    if (!current) continue;
    if (stableStringify(current) === stableStringify(draft)) delete out[key];
    else if (head) {
      const merged = merge3(draft.next, head, current.next);
      if (merged.ok) out[key] = { base: head, next: merged.merged };
    }
  }
  return out;
}

export function acceptSaved(
  submitted: Drafts,
  tooltips: Tooltip[],
  commit?: string,
  deleted: number[] = [],
  savedAt?: number,
): void {
  const state = useDraftStore.getState();
  const saved = new Map(tooltips.map((tooltip) => [tooltip.hash, tooltip]));
  const drafts = reconcileSaved(
    state.drafts,
    submitted,
    (hash) => saved.get(Number(hash)),
    (hash) => deleted.includes(Number(hash)),
  );
  rememberSaved([...saved.values()], deleted, Date.now(), savedAt);
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
