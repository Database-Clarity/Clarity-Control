import { languages, merge3, stableStringify, type Tooltip } from '@clarity/core';
import type { TranslationRevisions } from '../../../../../packages/core/src/translationRevision';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { rememberSaved } from '../../stores/savedOverlay';
import { retainedRevisions, sameDraftContent, type Drafts } from '../draftStorage';

/** The part of a draft store (Current or batch) that save reconciliation touches. */
export interface ReconciledStore {
  getState(): {
    hydrated: boolean;
    drafts: Drafts;
    ownsKey(key: string, hash: number): boolean;
    retry(): void;
  };
  setState(partial: { drafts: Drafts }): void;
}

export function replaceDraft(
  base: Tooltip,
  next: Tooltip,
  resetBase = false,
  revisions?: TranslationRevisions,
): void {
  replaceDraftAt(useDraftStore, String(base.hash), base, next, resetBase, revisions);
}

/** `replaceDraft` for any draft store and key (batch drafts: services/scheduled/batchDrafts.ts). */
export function replaceDraftAt(
  store: ReconciledStore,
  key: string,
  base: Tooltip,
  next: Tooltip,
  resetBase = false,
  revisions?: TranslationRevisions,
): void {
  if (base.hash !== next.hash) throw new Error('Cannot replace a draft with a different tooltip.');
  const state = store.getState();
  if (!state.hydrated) throw new Error('Draft recovery must finish before editing.');
  if (!state.ownsKey(key, base.hash))
    throw new Error(`Draft key ${key} does not belong to tooltip ${base.hash}.`);
  const previous = state.drafts[key];
  const original = resetBase ? base : (previous?.base ?? base);
  const translationRevisions = retainedRevisions(
    revisions ?? retainedRevisions(previous?.translationRevisions, previous?.next ?? base, next),
    original,
    next,
  );
  if (translationRevisions) {
    const text = { ...next.text };
    for (const lang of Object.keys(translationRevisions) as (keyof TranslationRevisions)[])
      text[lang] = original.text[lang];
    next = { ...next, text };
  }
  const drafts: Drafts = {
    ...state.drafts,
    [key]: {
      base: original,
      next,
      changedAt: new Date().toISOString(),
      ...(translationRevisions && { translationRevisions }),
    },
  };
  if (!translationRevisions && stableStringify(original) === stableStringify(next))
    delete drafts[key];
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
    if (sameDraftContent(current, draft)) delete out[key];
    else if (head) {
      const merged = merge3(draft.next, head, current.next);
      if (merged.ok) {
        const revised = { ...current.translationRevisions };
        for (const lang of languages) {
          if (lang === 'en') continue;
          const proof = revised[lang];
          if (
            proof &&
            stableStringify(proof) === stableStringify(draft.translationRevisions?.[lang] ?? null)
          )
            delete revised[lang];
        }
        const translationRevisions = retainedRevisions(revised, head, merged.merged);
        out[key] = { ...current, base: head, next: merged.merged, translationRevisions };
      }
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
  rememberSaved([...saved.values()], deleted, Date.now(), savedAt, commit);
  useDataStore.setState(({ data }) => {
    if (!data) throw new Error('Editor data disappeared during save.');
    const tooltips = { ...data.bundle.tooltips, ...Object.fromEntries(saved) };
    for (const hash of deleted) delete tooltips[hash];
    return {
      data: {
        ...data,
        tooltipSnapshot: data.tooltipSnapshot ?? data.bundle,
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
