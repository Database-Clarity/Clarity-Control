/**
 * Review save → a batch destination (spec "Editor UX" Review save; P3a; root ruling A,
 * 2026-11-14: the Destination row picks where the reviewed drafts go). The drafts go to
 * POST /batches/:id/save instead of /save, chunked to the Worker caps (15 changes per save into a
 * draft batch, 10 into a scheduled one), each chunk sent with the revision the previous one
 * returned. Data safety (root's conditions):
 * 1. A Current draft is dropped only after the Worker shows that exact tooltip with every field
 *    the draft changed in the batch (the members a chunk returned, else the member file at the
 *    next head); a draft edited during the save stays. Anything unconfirmed stays and is named.
 * 2. Current saved data is never touched: a batch save writes no current tooltip, bundle, or
 *    saved overlay.
 * 3. Each change carries the draft's current-saved base, so the Worker decides (merge against
 *    the stored proposal, revision CAS). Stale and conflict refusals are shown verbatim and never
 *    retried automatically.
 * 4. The batch-namespace drafts of that batch go in the same save and reconcile through
 *    acceptBatchSaved (only the confirmed ones).
 */
import { changedFields, withField, type Batch, type BatchMember } from '@clarity/core/schedule';
import { stableStringify } from '@clarity/core';
import type { Change } from '../../../services/api';
import type { Drafts } from '../../../services/draftStorage';
import { zonedNotBefore } from '../../../services/format/date';
import {
  BatchRefusal,
  PartialBatchSave,
  accountChanged,
  createBatch,
  draftSaveParts,
  queueBatchSave,
  queueStagedScheduledSave,
  readBatchMembers,
  readBatchStatus,
  saveChunk,
  saveToBatch,
  waitForBatchSave,
  type BatchAdmission,
} from '../../../services/scheduled/api';
import {
  acceptBatchSaved,
  batchDraftKey,
  draftsOfBatch,
  useBatchDraftStore,
} from '../../../services/scheduled/batchDrafts';
import { useDraftStore } from '../../../stores/drafts';
import { newOpId } from '../../../services/publisher/ulid';
import { useDataStore } from '../../../stores/data';
import { preparationEnabled } from '../../../services/scheduled/flag';
import { fieldList, isPreparation } from './model';
import { nameFor } from './names';
import { refreshBatches, startBatches, useBatches } from './store';

export type Destination =
  { kind: 'current' } | { kind: 'batch'; id: string } | { kind: 'new'; name: string };

type BatchProgress = (
  batchId: string,
  confirmed: ReadonlySet<number>,
  total: number,
  uploading?: number,
) => void;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The leave guard covers batch drafts as it covers Current ones (Layout: a pending or failed
// draft write asks before the page unloads).
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (event) => {
    const { pending, error } = useBatchDraftStore.getState();
    if (pending || error) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

/** "Saved to <batch>; not published before <zoned time>" (or that no time is set yet). */
export function savedLine(batch: Pick<Batch, 'name' | 'notBefore'>, count: number) {
  const when = batch.notBefore
    ? `not published before ${zonedNotBefore(batch.notBefore)}`
    : 'not published before a time is set (Review → Batches → Schedule…)';
  return `Saved ${plural(count, 'tooltip')} to ${batch.name}; ${when}.`;
}

/** The batch's stored proposal holds every field `sent` changed, as `sent` has it. */
export function confirms(member: BatchMember | null | undefined, sent: Change): boolean {
  if (!member || member.hash !== sent.hash) return false;
  return changedFields(sent.base, sent.next).every(
    (field) => !changedFields(member.proposed, withField(member.proposed, sent.next, field)).length,
  );
}

function refusalText(error: unknown): string {
  if (!(error instanceof BatchRefusal))
    return error instanceof Error ? error.message : String(error);
  const data = useDataStore.getState().data;
  const lines = error.members.map(
    (member) =>
      `${nameFor(data, member.hash)} (${member.hash})${member.fields?.length ? `: ${fieldList(member.fields)}` : ''}${member.reason ? ` (${member.reason})` : ''}`,
  );
  return [error.message, ...lines].join('\n');
}

/** The batch-namespace drafts staged for `batchId` (keyed batch:<id>:<hash>). */
export function stagedDrafts(batchId: string): Drafts {
  const out: Drafts = {};
  for (const [hash, draft] of draftsOfBatch(useBatchDraftStore.getState().drafts, batchId))
    out[batchDraftKey(batchId, hash)] = draft;
  return out;
}

/**
 * Saves the reviewed `changes` (already prepared and validated by the save review) plus the
 * destination batch's own staged drafts (prepared here with `prepare`) to the batch. Returns the
 * notice for the save dock; throws an Error naming what was not saved and why.
 */
export async function saveReviewToBatch(
  destination: Exclude<Destination, { kind: 'current' }>,
  changes: readonly Change[],
  message: string,
  submitted: Drafts,
  /** False once the session changed after the save began (account, token, or auth reloading). */
  sameAccount: () => boolean,
  /** The save review's enrichment and validation, for the batch's staged drafts. */
  prepare: (changes: Change[]) => Promise<Change[]>,
  onConfirmed?: (members: BatchMember[]) => void,
  onProgress?: BatchProgress,
): Promise<string> {
  const data = useDataStore.getState().data;
  const name = (hash: number) => `${nameFor(data, hash)} (${hash})`;
  // Every write goes out as the account that began the save (code review round 1): checked before
  // creating, after each await, and right before each chunk (saveToBatch `proceed`).
  const sameAccountOr = (what: string) => {
    if (!sameAccount()) throw new Error(`${accountChanged}. ${what} Drafts stay as they are.`);
  };
  let batch: Pick<Batch, 'id' | 'name' | 'revision' | 'status' | 'notBefore'>;
  let staged: Drafts = {};
  let stagedChanges: Change[] = [];
  const batchOwner = useBatchDraftStore.getState().owner;
  if (destination.kind === 'new') {
    sameAccountOr('No batch was created.');
    try {
      batch = (await createBatch(destination.name.trim())).batch;
    } catch (error) {
      throw new Error(`No batch was created. ${refusalText(error)}`);
    }
  } else {
    // The newest listing: the save merges per tooltip on the server, so it builds on the batch
    // as it is now; a write that lands in between is still refused by the revision check.
    await refreshBatches();
    sameAccountOr('Nothing was saved.');
    const entry = useBatches
      .getState()
      .entries?.find((candidate) => candidate.id === destination.id);
    if (!entry) throw new Error('That batch is no longer listed. Pick another destination.');
    if (entry.status !== 'draft' && entry.status !== 'scheduled')
      throw new Error(
        isPreparation(entry.status)
          ? `${entry.name} has a request ${entry.status === 'preparing' ? 'preparing' : 'that needs attention'}; save to it once that settles. Nothing was saved.`
          : `${entry.name} is ${entry.status}; it takes no more changes.`,
      );
    staged = stagedDrafts(entry.id);
    const both = Object.values(staged)
      .map(({ next }) => next.hash)
      .filter((hash) => changes.some((change) => change.hash === hash));
    if (both.length)
      throw new Error(
        `${both.map(name).join(', ')} ${both.length === 1 ? 'has' : 'have'} a Current draft and a draft staged for ${entry.name}. Save or discard one of them first. Nothing was saved.`,
      );
    stagedChanges = Object.values(staged).length
      ? await prepare(
          Object.values(staged).map(({ base, next }) => ({ hash: next.hash, base, next })),
        )
      : [];
    sameAccountOr('Nothing was saved.');
    batch = entry;
  }
  const all = [...changes, ...stagedChanges];
  const sent = new Map(all.map((change) => [change.hash, change]));
  const payload = all.map(({ hash, base, next }) => ({ hash, base, next }));
  const save: SaveContext = {
    batchId: batch.id,
    sent,
    submitted,
    staged,
    batchOwner,
    sameAccount,
    onConfirmed,
  };
  if (preparationEnabled()) {
    const nothing =
      destination.kind === 'new'
        ? `Created ${batch.name}, but nothing was queued to it.`
        : `Nothing was saved to ${batch.name}.`;
    if (batch.status === 'scheduled' && payload.length > saveChunk.scheduled)
      return stageScheduledBatch(batch, payload, message, save, onProgress);
    sameAccountOr('Nothing was saved.');
    if (batch.status === 'draft') {
      const status = await readBatchStatus(batch.id);
      sameAccountOr('Nothing was saved.');
      const parts = draftSaveParts(payload, message);
      if (status.batch.draftStaging || parts.length > 1)
        return stageDraftBatch(status.batch, parts, message, save, onProgress);
    }
    let admission: BatchAdmission;
    try {
      admission = await queueBatchSave(batch.id, batch.revision, payload, message);
    } catch (error) {
      void refreshBatches();
      throw new Error(`${nothing} ${refusalText(error)}`);
    }
    // Nothing is saved yet: every draft stays until the preparer lands the save (settleQueued).
    trackQueued(admission.requestId, save);
    void refreshBatches();
    return `Save queued to ${batch.name}: ${plural(all.length, 'tooltip')} preparing. Drafts stay until the save lands.`;
  }
  let members: BatchMember[];
  let accepted: number[];
  let failure: PartialBatchSave | null = null;
  try {
    const result = await saveToBatch(
      batch.id,
      batch.revision,
      batch.status,
      payload,
      message,
      sameAccount,
    );
    ({ members, accepted } = result);
  } catch (error) {
    void refreshBatches();
    if (!(error instanceof PartialBatchSave)) {
      // Nothing was committed: every draft stays as it is.
      const text = refusalText(error);
      throw new Error(
        destination.kind === 'new'
          ? `Created ${batch.name}, but nothing was saved to it. ${text}`
          : `Nothing was saved to ${batch.name}. ${text}`,
      );
    }
    failure = error;
    ({ members, accepted } = error.saved);
  }
  // Confirmation: the returned members, else (a change the batch already held: no write) the
  // member file at the head the next listing names.
  const shown = new Map(members.map((member) => [member.hash, member]));
  const unread = accepted.filter((hash) => !shown.has(hash));
  if (unread.length) {
    try {
      await refreshBatches();
      const head = useBatches.getState().head;
      if (head)
        (await readBatchMembers(head, batch.id, unread)).forEach((member) => {
          if (member) shown.set(member.hash, member);
        });
    } catch {
      // Unconfirmed drafts simply stay.
    }
  }
  const confirmed = accepted.filter((hash) => confirms(shown.get(hash), sent.get(hash)!));
  const confirmedSet = new Set(confirmed);
  const { kept, notes } = reconcile(save, confirmed, shown);
  void refreshBatches();
  void refreshUpcoming();
  const missing = all.map(({ hash }) => hash).filter((hash) => !confirmedSet.has(hash));
  if (failure || missing.length) {
    const reason = failure
      ? refusalText(failure.reason)
      : 'The batch does not show these changes; reload Review → Batches and check it.';
    throw new Error(
      `Saved ${confirmed.length} of ${all.length} to ${batch.name}. Not saved, drafts kept: ${missing.map(name).join(', ')}. ${reason}${notes.length ? ` ${notes.join(' ')}` : ''}`,
    );
  }
  const after = useBatches.getState().entries?.find((entry) => entry.id === batch.id) ?? batch;
  return [
    savedLine({ name: batch.name, notBefore: after.notBefore }, confirmed.length),
    kept ? `${plural(kept, 'draft')} changed during the save and stayed in Current.` : '',
    ...notes,
  ]
    .filter(Boolean)
    .join(' ');
}

async function stageDraftBatch(
  batch: Batch,
  parts: Change[][],
  message: string,
  save: SaveContext,
  onProgress?: BatchProgress,
): Promise<string> {
  const id = batch.draftStaging?.id ?? newOpId();
  const confirmed = new Set<number>();
  const total = parts.reduce((count, chunk) => count + chunk.length, 0);
  const notify = () => onProgress?.(batch.id, new Set(confirmed), total);
  let revision = batch.revision;
  notify();
  try {
    for (const [index, chunk] of parts.entries()) {
      if (!save.sameAccount()) throw new Error(accountChanged);
      const requestId = newOpId();
      await queueBatchSave(batch.id, revision, chunk, message, requestId, {
        id,
        finish: index === parts.length - 1,
      });
      const saved = await waitForBatchSave(batch.id, requestId, save.sameAccount);
      revision = saved.revision;
      const accepted = await confirmStage(batch.id, chunk, save);
      for (const hash of accepted) confirmed.add(hash);
      notify();
      if (useDraftStore.getState().error || useBatchDraftStore.getState().error)
        throw new Error('The batch saved these changes, but local draft storage needs attention.');
      if (accepted.length !== chunk.length)
        throw new Error('The batch did not confirm every change. The remaining drafts were kept.');
    }
  } catch (error) {
    void refreshBatches();
    throw new Error(
      `Saved ${confirmed.size} of ${total} to ${batch.name}. Remaining drafts were kept. ${refusalText(error)}`,
    );
  }
  void refreshUpcoming();
  return savedLine(batch, confirmed.size);
}

async function confirmStage(batchId: string, changes: readonly Change[], save: SaveContext) {
  if (!save.sameAccount()) throw new Error(accountChanged);
  await refreshBatches();
  const { head } = useBatches.getState();
  if (!head) throw new Error('The saved batch could not be read. Reload and retry.');
  const members = await readBatchMembers(
    head,
    batchId,
    changes.map(({ hash }) => hash),
  );
  if (!save.sameAccount()) throw new Error(accountChanged);
  const shown = new Map(members.flatMap((member) => (member ? [[member.hash, member]] : [])));
  const accepted = changes
    .filter((change) => confirms(shown.get(change.hash), change))
    .map(({ hash }) => hash);
  reconcile(save, accepted, shown);
  await Promise.all([useDraftStore.getState().flush(), useBatchDraftStore.getState().flush()]);
  return accepted;
}

async function stageScheduledBatch(
  batch: Pick<Batch, 'id' | 'name' | 'revision' | 'notBefore'>,
  payload: Change[],
  message: string,
  save: SaveContext,
  onProgress?: BatchProgress,
): Promise<string> {
  const none = new Set<number>();
  const notify = (uploaded: number) => onProgress?.(batch.id, none, payload.length, uploaded);
  notify(0);
  const admission = await queueStagedScheduledSave(
    batch.id,
    batch.revision,
    payload,
    message,
    save.sameAccount,
    notify,
  );
  const saved = await waitForBatchSave(batch.id, admission.requestId, save.sameAccount);
  const confirmed = new Set(await confirmStage(batch.id, payload, save));
  onProgress?.(batch.id, confirmed, payload.length);
  if (confirmed.size !== payload.length)
    throw new Error('The batch did not confirm every change. The remaining drafts were kept.');
  void refreshUpcoming();
  return savedLine(saved, confirmed.size);
}

/** What a batch save needs to drop exactly the drafts the batch confirms. */
interface SaveContext {
  batchId: string;
  /** The changes sent, by hash. */
  sent: Map<number, Change>;
  /** The Current drafts as the save review submitted them. */
  submitted: Drafts;
  /** The batch drafts sent along (batch:<id>:<hash>). */
  staged: Drafts;
  batchOwner: string | null;
  sameAccount: () => boolean;
  onConfirmed?: (members: BatchMember[]) => void;
  /** Queued saves: member checks made after the request completed. */
  checks?: number;
}

/**
 * Drops the drafts of `confirmed` hashes (the batch shows their every changed field): Current
 * drafts nobody edited since, and the batch drafts through acceptBatchSaved. Only for the account
 * that saved; everything else stays.
 */
function reconcile(
  save: SaveContext,
  confirmed: readonly number[],
  shown: ReadonlyMap<number, BatchMember>,
): { kept: number; notes: string[] } {
  let kept = 0;
  const notes: string[] = [];
  if (!save.sameAccount()) return { kept, notes };
  const confirmedSet = new Set(confirmed);
  try {
    save.onConfirmed?.(confirmed.map((hash) => shown.get(hash)!));
  } catch {
    // The Worker receipt remains authoritative even if the local preview cannot refresh.
    notes.push('Saved changes could not be shown in the preview. Reload to see them.');
  }
  // Current drafts: drop the confirmed ones that nobody edited during the save.
  const store = useDraftStore.getState();
  for (const hash of confirmed) {
    const before = save.submitted[String(hash)];
    const now = store.drafts[String(hash)];
    if (!before || !now) continue;
    if (stableStringify(now) === stableStringify(before)) store.discard(hash);
    else kept++;
  }
  // Batch drafts: P3-0's reconciliation, for the confirmed ones only.
  const settled: Drafts = {};
  for (const [key, draft] of Object.entries(save.staged))
    if (confirmedSet.has(draft.next.hash)) settled[key] = draft;
  if (Object.keys(settled).length && save.batchOwner)
    try {
      acceptBatchSaved(
        save.batchId,
        settled,
        Object.values(settled).map(({ next }) => shown.get(next.hash)!),
        save.batchOwner,
      );
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  return { kept, notes };
}

/** Queued saves of this page by requestId (memory only: after a reload their drafts simply stay). */
const queued = new Map<string, SaveContext>();
let stopWatching: (() => void) | undefined;

function trackQueued(requestId: string, save: SaveContext) {
  queued.set(requestId, save);
  if (stopWatching) return;
  // Keep the listing refreshing while a save is outstanding, and settle on every new listing.
  const stopRefresh = startBatches();
  const unsubscribe = useBatches.subscribe((state, before) => {
    if (state.entries !== before.entries) void settleQueued();
  });
  stopWatching = () => {
    stopRefresh();
    unsubscribe();
    stopWatching = undefined;
  };
}

/**
/**
 * A queued save settles by its own request record (GET status?requestId; the index is advisory):
 * pending or needs_attention waits; failed or cancelled keeps every draft (the save never
 * applied); completed drops only the drafts the batch shows, once the listing has reached the
 * request's result revision. Never earlier, so no savedAt or Saved shows before the save lands.
 */
let settling = false;
export async function settleQueued(): Promise<void> {
  if (settling) return;
  settling = true;
  try {
    for (const [requestId, save] of [...queued]) {
      const { entries, head } = useBatches.getState();
      if (!entries || !head) return;
      if (!save.sameAccount()) {
        queued.delete(requestId);
        continue;
      }
      try {
        const { request } = await readBatchStatus(save.batchId, undefined, requestId);
        if (!request || request.status === 'pending' || request.status === 'needs_attention')
          continue;
        if (request.status !== 'completed') {
          queued.delete(requestId);
          continue;
        }
        const entry = entries.find((candidate) => candidate.id === save.batchId);
        const landed = request.result?.revision;
        if (entry && typeof landed === 'number' && entry.revision < landed) continue;
        // Tracking ends only after a member read: a failed read keeps it (next listing asks
        // again); hashes not confirmed yet get up to three listings (a head that lags the write).
        const members = await readBatchMembers(head, save.batchId, [...save.sent.keys()]);
        const shown = new Map(
          members
            .filter((member): member is BatchMember => member !== null)
            .map((member) => [member.hash, member]),
        );
        const confirmed = [...save.sent.keys()].filter((hash) =>
          confirms(shown.get(hash), save.sent.get(hash)!),
        );
        if (confirmed.length) {
          reconcile(save, confirmed, shown);
          for (const hash of confirmed) save.sent.delete(hash);
          void refreshUpcoming();
        }
        save.checks = (save.checks ?? 0) + 1;
        if (!save.sent.size || save.checks >= 3) queued.delete(requestId);
      } catch {
        // Unreadable now: the drafts stay, and the next listing asks again.
      }
    }
  } finally {
    settling = false;
    if (!queued.size) stopWatching?.();
  }
}

/** Tests: forget queued saves. */
export function resetQueued() {
  queued.clear();
  stopWatching?.();
}

/** The editor's Current / Upcoming listing picks the new members up at once. */
async function refreshUpcoming() {
  try {
    const { refreshBatches: refresh } = await import('../../tooltip/UpcomingSwitch.load');
    await refresh();
  } catch {
    // The editor re-lists on its own timer.
  }
}
