/**
 * Batch drafts (scheduled changes, spec "Editor UX" Drafts per destination, R6; phase P3-0).
 *
 * A draft for a batch destination is keyed `batch:<batchId>:<hash>` in its own draft store
 * (stores/drafts.ts `createDraftStore`, so it has the Current store's write queue, failed-write
 * recovery, account switching, and cross-tab handling) and its own IndexedDB buckets
 * `batch-drafts:user:<id>` next to the Current ones. Its `base` is the batch member's stored
 * proposal (or current saved when the tooltip joins the batch); the Worker merges a batch save
 * against that. Current drafts keep their keys, buckets, bytes, and channel messages: nothing
 * here reads or writes them, and the Current store never sees a batch key.
 *
 * Loaded only when the build switch is ON (services/scheduled/flag.ts): stores/drafts.ts imports
 * this module behind the switch, so with it OFF nothing reads or writes these buckets (I6).
 * Signed out there is no batch destination: the signed-out bucket is always empty and refuses
 * writes, and the store refuses edits.
 */
import { tooltipSchema, type Lang, type Tooltip } from '@clarity/core';
import { batchIdSchema, type BatchMember } from '@clarity/core/schedule';
import { z } from 'zod';
import { createDraftStore, type useDraftStore } from '../../stores/drafts';
import { createIndexedDbBucket, type DraftStorage, type Drafts } from '../draftStorage';
import { reconcileSaved, replaceDraftAt } from '../save/drafts';

const keyPattern = /^batch:([^:]+):(0|[1-9]\d*)$/;

export const batchDraftKey = (batchId: string, hash: number) => `batch:${batchId}:${hash}`;

/** The batch and hash of a batch draft key; null for anything else (a Current key included). */
export function parseBatchDraftKey(key: string): { batchId: string; hash: number } | null {
  const match = keyPattern.exec(key);
  if (!match || !batchIdSchema.safeParse(match[1]).success) return null;
  const hash = Number(match[2]);
  return Number.isSafeInteger(hash) ? { batchId: match[1], hash } : null;
}

export const batchDraftsSchema = z
  .record(z.string(), z.object({ base: tooltipSchema, next: tooltipSchema }))
  .refine(
    (drafts) =>
      Object.entries(drafts).every(([key, { base, next }]) => {
        const parsed = parseBatchDraftKey(key);
        return parsed !== null && parsed.hash === base.hash && base.hash === next.hash;
      }),
    'Batch draft keys must be batch:<batchId>:<hash> and match their tooltips',
  );

export const batchBucketKey = (userId: string) => `batch-drafts:user:${userId}`;

const signedOut: DraftStorage = {
  read: () => Promise.resolve({}),
  write: () => Promise.reject(new Error('Sign in to keep batch drafts')),
};

/** Batch draft buckets: one per account, none signed out. `origin` names the tab (tests). */
export function createBatchDraftStorage(origin?: string): DraftStorage {
  const users = new Map<string, DraftStorage>();
  return {
    ...signedOut,
    forUser(userId) {
      let storage = users.get(userId);
      if (!storage) {
        storage = createIndexedDbBucket(batchBucketKey(userId), batchDraftsSchema, origin);
        users.set(userId, storage);
      }
      return storage;
    },
  };
}

export function createBatchDraftStore(storage: DraftStorage) {
  return createDraftStore(storage, { requireOwner: true });
}
export type BatchDraftStore = ReturnType<typeof createBatchDraftStore>;

export const useBatchDraftStore = createBatchDraftStore(createBatchDraftStorage());

/**
 * Makes `batch` follow `current`'s account: every account switch of the Current store (a new
 * generation) activates the same account here, signed out included. Returns the stop function.
 */
export function linkBatchDrafts(current: typeof useDraftStore, batch: BatchDraftStore) {
  let generation = 0;
  const follow = () => {
    const state = current.getState();
    if (state.generation === generation) return;
    generation = state.generation;
    void batch.getState().activate(state.owner);
  };
  follow();
  return current.subscribe(follow);
}

/** The drafts of one batch, keyed by hash. */
export function draftsOfBatch(drafts: Drafts, batchId: string): Map<number, Drafts[string]> {
  const out = new Map<number, Drafts[string]>();
  for (const [key, draft] of Object.entries(drafts)) {
    const parsed = parseBatchDraftKey(key);
    if (parsed?.batchId === batchId) out.set(parsed.hash, draft);
  }
  return out;
}

export function editBatchDraft(
  batchId: string,
  base: Tooltip,
  lang: Lang,
  text: string,
  author: string,
  store: BatchDraftStore = useBatchDraftStore,
): void {
  store.getState().editAt(batchDraftKey(batchId, base.hash), base, lang, text, author);
}

export function updateBatchDrafts(
  batchId: string,
  updates: { base: Tooltip; update: (tooltip: Tooltip) => Tooltip }[],
  store: BatchDraftStore = useBatchDraftStore,
): void {
  store
    .getState()
    .updateDraftsAt(
      updates.map((update) => ({ ...update, key: batchDraftKey(batchId, update.base.hash) })),
    );
}

export function discardBatchDraft(
  batchId: string,
  hash: number,
  store: BatchDraftStore = useBatchDraftStore,
): void {
  store.getState().discardAt(batchDraftKey(batchId, hash));
}

/** `replaceDraft` for a batch destination (conflict recovery and rebase: `resetBase`). */
export function replaceBatchDraft(
  batchId: string,
  base: Tooltip,
  next: Tooltip,
  resetBase = false,
  store: BatchDraftStore = useBatchDraftStore,
): void {
  replaceDraftAt(store, batchDraftKey(batchId, base.hash), base, next, resetBase);
}

/**
 * Reconciles a batch save (POST /batches/:id/save returned `members`): touches only the submitted
 * keys of this batch, never the Current drafts, the saved bundle, or the saved overlay (a batch
 * save changes no current saved tooltip). An unchanged submitted draft is dropped; one edited
 * during the save is rebased on the member's stored proposal.
 */
export function acceptBatchSaved(
  batchId: string,
  submitted: Drafts,
  members: Pick<BatchMember, 'hash' | 'proposed'>[],
  store: BatchDraftStore = useBatchDraftStore,
): void {
  for (const key of Object.keys(submitted))
    if (parseBatchDraftKey(key)?.batchId !== batchId)
      throw new Error(`Draft ${key} is not in batch ${batchId}; drafts were retained.`);
  const proposed = new Map(members.map((member) => [member.hash, member.proposed]));
  const state = store.getState();
  const drafts = reconcileSaved(state.drafts, submitted, (key) =>
    proposed.get(parseBatchDraftKey(key)!.hash),
  );
  store.setState({ drafts });
  state.retry();
}
