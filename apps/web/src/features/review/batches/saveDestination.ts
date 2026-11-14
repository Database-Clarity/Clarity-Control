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
  memberCap,
  readBatchMembers,
  saveToBatch,
} from '../../../services/scheduled/api';
import {
  acceptBatchSaved,
  batchDraftKey,
  draftsOfBatch,
  useBatchDraftStore,
} from '../../../services/scheduled/batchDrafts';
import { useDraftStore } from '../../../stores/drafts';
import { useDataStore } from '../../../stores/data';
import { fieldList } from './model';
import { nameFor } from './names';
import { refreshBatches, useBatches } from './store';

export type Destination =
  { kind: 'current' } | { kind: 'batch'; id: string } | { kind: 'new'; name: string };

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
  /** False once the signed-in account changed after the save began. */
  sameAccount: () => boolean,
  /** The save review's enrichment and validation, for the batch's staged drafts. */
  prepare: (changes: Change[]) => Promise<Change[]>,
): Promise<string> {
  const data = useDataStore.getState().data;
  const name = (hash: number) => `${nameFor(data, hash)} (${hash})`;
  // Every write goes out as the account that began the save (code review round 1): checked before
  // creating, after each await, and right before each chunk (saveToBatch `proceed`).
  const sameAccountOr = (what: string) => {
    if (!sameAccount()) throw new Error(`${accountChanged}. ${what} Drafts stay as they are.`);
  };
  // The Worker's member cap, checked before anything is written (it refuses the same).
  const overCap = (label: string, held: readonly number[], sending: readonly Change[]) => {
    const total = new Set([...held, ...sending.map(({ hash }) => hash)]).size;
    if (total > memberCap)
      throw new Error(
        `A batch holds at most ${memberCap} tooltips; this save would bring ${label} to ${total}. Nothing was saved.`,
      );
  };
  let batch: Pick<Batch, 'id' | 'name' | 'revision' | 'status' | 'notBefore'>;
  let staged: Drafts = {};
  let stagedChanges: Change[] = [];
  const batchOwner = useBatchDraftStore.getState().owner;
  if (destination.kind === 'new') {
    overCap(destination.name.trim(), [], changes);
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
      throw new Error(`${entry.name} is ${entry.status}; it takes no more changes.`);
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
    overCap(entry.name, entry.hashes, [...changes, ...stagedChanges]);
    sameAccountOr('Nothing was saved.');
    batch = entry;
  }
  const all = [...changes, ...stagedChanges];
  const sent = new Map(all.map((change) => [change.hash, change]));
  const payload = all.map(({ hash, base, next }) => ({ hash, base, next }));
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
  let kept = 0;
  const notes: string[] = [];
  if (sameAccount()) {
    // Current drafts: drop the confirmed ones that nobody edited during the save.
    const store = useDraftStore.getState();
    for (const hash of confirmed) {
      const before = submitted[String(hash)];
      const now = store.drafts[String(hash)];
      if (!before || !now) continue;
      if (stableStringify(now) === stableStringify(before)) store.discard(hash);
      else kept++;
    }
    // Batch drafts: P3-0's reconciliation, for the confirmed ones only.
    const settled: Drafts = {};
    for (const [key, draft] of Object.entries(staged))
      if (confirmedSet.has(draft.next.hash)) settled[key] = draft;
    if (Object.keys(settled).length && batchOwner)
      try {
        acceptBatchSaved(
          batch.id,
          settled,
          Object.values(settled).map(({ next }) => shown.get(next.hash)!),
          batchOwner,
        );
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error));
      }
  }
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

/** The editor's Current / Upcoming listing picks the new members up at once. */
async function refreshUpcoming() {
  try {
    const { refreshBatches: refresh } = await import('../../tooltip/UpcomingSwitch.load');
    await refresh();
  } catch {
    // The editor re-lists on its own timer.
  }
}
