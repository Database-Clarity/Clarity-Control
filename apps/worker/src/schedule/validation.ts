import { z } from 'zod';
import {
  hashSchema,
  merge3,
  reconcileNumberMap,
  stableStringify,
  tooltipSchema,
  type Tooltip,
} from '@clarity/core';
import {
  activate,
  resolveActivation,
  batchMemberSchema,
  changedFields,
  composeParsed as compose,
  isTranslationField,
  withField,
  type Batch,
  type BatchMember,
} from '@clarity/core/schedule';
import { refuseUnlowerable } from '../elementTags.js';
import type { RepoFile } from '../github.js';
import { HttpError } from '../http.js';
import {
  checkEdit,
  checkEnglishRevision,
  checkTranslationStamps,
  type Access,
} from '../permissions.js';
import type { Identity } from '../types.js';
import { unpublishedMessage } from './store.js';

export const batchSaveChangeSchema = z
  .object({ hash: hashSchema, base: tooltipSchema.nullable(), next: tooltipSchema })
  .strict()
  .refine(({ hash, base, next }) => next.hash === hash && (!base || base.hash === hash), {
    message: 'Change hash, base hash and next hash must agree',
  });

// Both sides are schema-parsed already: equal canonical text = equal contentHash.
export const sameTooltip = (a: Tooltip | null, b: Tooltip | null) =>
  a === null || b === null ? a === b : stableStringify(a) === stableStringify(b);
/**
 * `from` with each of `fields` taken from `to`. Stored proposals only ever move by a field the
 * shared changed-field set reports, so a stamp-only difference (R17: a no-op for approvedDigest
 * and contentRevision) never reaches storage and can never change what publishes (I5).
 */
export function overlay(from: Tooltip | null, to: Tooltip, fields: readonly string[]): Tooltip {
  if (from === null) return to;
  let value = from;
  for (const field of fields) value = withField(value, to, field);
  return tooltipSchema.parse(value);
}

export function parseMember(value: unknown, batchId: string, hash: number): BatchMember {
  const member = batchMemberSchema.parse(value);
  if (member.hash !== hash)
    throw new HttpError(502, `Stored member ${hash} of ${batchId} mismatch`);
  return member;
}

export interface Conflict {
  hash: number;
  base: Tooltip | null;
  head: Tooltip | null;
  next: Tooltip;
  fields: string[];
}

/** Full semantic save validation, shared by synchronous admission and the offline preparer. No I/O. */
export function validateBatchSave({
  batch,
  batchId,
  input,
  own,
  files,
  pushed,
  pin,
  access,
  now,
  user,
  head,
}: {
  batch: Batch;
  batchId: string;
  input: { changes: z.infer<typeof batchSaveChangeSchema>[] };
  own: ReadonlySet<number>;
  files: readonly (RepoFile | null)[];
  pushed?: ReadonlySet<number>;
  pin?: { value: unknown };
  access: Access;
  now: string;
  user: Identity;
  head: string;
}) {
  const blocked: { hash: number; fields: string[] }[] = [];
  const stale: { hash: number; reason: string }[] = [];
  const conflicts: Conflict[] = [];
  const before: BatchMember[] = [];
  const written: BatchMember[] = [];
  for (const [index, change] of input.changes.entries()) {
    const file = files[index];
    if (own.has(change.hash)) {
      if (!file) throw new HttpError(502, `Batch member ${change.hash} is unreadable`);
      const stored = parseMember(file.value, batchId, change.hash);
      let merged = change.next;
      if (change.base === null) {
        // A previously admitted draft part may have landed before its response was lost.
        if (batch.status === 'draft' && !changedFields(stored.proposed, change.next).length)
          continue;
        conflicts.push({ ...change, head: stored.proposed, fields: ['$exists'] });
        continue;
      }
      // Before the merge against what the client edited, after it against the stored proposal
      // (save.ts:107/:127); the second check is the authoritative one.
      checkEdit(access, change.base, change.next);
      if (!sameTooltip(change.base, stored.proposed)) {
        const result = merge3(change.base, stored.proposed, change.next);
        if (!result.ok) {
          conflicts.push({
            ...change,
            head: stored.proposed,
            fields: result.conflicts.map(({ field }) => field),
          });
          continue;
        }
        merged = result.merged;
      }
      checkEdit(access, stored.proposed, merged);
      const changed = changedFields(stored.proposed, merged);
      if (!changed.length) continue; // stamp-only or identical: a no-op (R17)
      if (batch.status !== 'draft' && changed.some((field) => !isTranslationField(field)))
        throw new HttpError(409, 'Unschedule to edit', { hash: change.hash, fields: changed });
      const proposed = overlay(stored.proposed, merged, changed);
      if (proposed.text.en) {
        const english = { ...proposed.text.en };
        const numbers =
          stored.proposed.text.en?.text === english.text
            ? stored.proposed.text.en.numbers
            : reconcileNumberMap(stored.proposed.text.en, english, proposed);
        delete english.numbers;
        if (numbers) english.numbers = numbers;
        proposed.text.en = english;
      }
      // A batch save has no "No translation impact" tick (direct saves only, with their audit
      // trailer): an English change needs a new, newer revision.
      checkEnglishRevision(access, stored.proposed, proposed, false, Date.parse(now));
      const currentFile = files[input.changes.length + index];
      const current = currentFile ? tooltipSchema.parse(currentFile.value) : null;
      if (current && current.hash !== change.hash)
        throw new HttpError(502, 'Stored tooltip hash mismatch');
      // Use the real Upcoming projection: identical concurrent English wording keeps
      // current's revision, even when the batch itself changed English.
      const projection = { base: stored.base, current, proposed };
      const activation = activate(projection);
      let english = activation.ok ? activation.tooltip.text.en : proposed.text.en;
      if (!activation.ok) {
        const choices: Record<string, 'upcoming'> = {};
        for (const field of activation.fields)
          if (field !== '$exists' || (stored.base !== null && current === null))
            choices[field] = 'upcoming';
        for (let pass = 0; pass < 2; pass++) {
          const resolved = resolveActivation({ ...projection, choices });
          if (resolved.ok) {
            english = resolved.tooltip?.text.en;
            break;
          }
          for (const field of resolved.missing) choices[field] = 'upcoming';
        }
      }
      checkTranslationStamps(stored.proposed, proposed, english ?? proposed.text.en);
      refuseUnlowerable(proposed, pin, 'saved', stored.proposed);
      const member = batchMemberSchema.parse({
        ...stored,
        proposed,
        updatedAt: now,
        updatedBy: user.login,
      });
      if (pushed) {
        const snapshotFile = files[2 * input.changes.length + index];
        const composed = compose({
          hash: change.hash,
          base: member.base,
          proposed: member.proposed,
          snapshot: snapshotFile ? tooltipSchema.parse(snapshotFile.value) : null,
          pushed: pushed.has(change.hash),
        });
        if (composed.status === 'stale') stale.push({ hash: change.hash, reason: composed.reason });
        else if (composed.status === 'overlay' && composed.unpublished.length)
          blocked.push({ hash: change.hash, fields: composed.unpublished });
      }
      before.push(stored);
      written.push(member);
    } else {
      const current = file ? tooltipSchema.parse(file.value) : null;
      if (current && current.hash !== change.hash)
        throw new HttpError(502, 'Stored tooltip hash mismatch');
      // Adding sets base = current at this head; the client must have started from it.
      if (!sameTooltip(change.base, current)) {
        conflicts.push({
          ...change,
          head: current,
          fields: change.base === null || current === null ? ['$exists'] : ['$base'],
        });
        continue;
      }
      checkEdit(access, current, change.next);
      const changed = changedFields(current, change.next);
      if (!changed.length) continue; // nothing to stage
      const proposed = overlay(current, change.next, changed);
      if (proposed.text.en) {
        const english = { ...proposed.text.en };
        const numbers =
          current?.text.en?.text === english.text
            ? current.text.en.numbers
            : reconcileNumberMap(current?.text.en, english, proposed);
        delete english.numbers;
        if (numbers) english.numbers = numbers;
        proposed.text.en = english;
      }
      checkEnglishRevision(access, current, proposed, false, Date.parse(now));
      checkTranslationStamps(current, proposed);
      refuseUnlowerable(proposed, pin, 'saved', current);
      const member = batchMemberSchema.parse({
        hash: change.hash,
        base: current,
        baseCommit: head,
        proposed,
        updatedAt: now,
        updatedBy: user.login,
      });
      written.push(member);
    }
  }
  if (conflicts.length) return { conflicts, before, written };
  // Same wording as schedule (lifecycle.ts): stale members need an unschedule and a rebase,
  // unpublished fields need a publish first.
  if (stale.length)
    throw new HttpError(409, 'Current changed under this batch; rebase the listed tooltips', {
      members: stale,
    });
  if (blocked.length) throw new HttpError(409, unpublishedMessage, { members: blocked });
  return { conflicts, before, written };
}

/** A refusal that lists per-hash reasons (stale, unpublished, conflict files). */
export function refuseScheduleMembers(
  message: string,
  members: { hash: number; fields?: string[]; reason?: string }[],
): never {
  throw new HttpError(409, message, { members });
}

/** Full member composition and activation validation at an already pinned head. No I/O. */
export function validateScheduleMembers(
  hashes: readonly number[],
  files: readonly (RepoFile | null)[],
  pushed: ReadonlySet<number>,
) {
  const members: BatchMember[] = [];
  const composed: Tooltip[] = [];
  const snapshots = new Map<number, Tooltip | null>();
  const stale: { hash: number; fields?: string[]; reason?: string }[] = [];
  const unpublished: { hash: number; fields: string[] }[] = [];
  const blocked: { hash: number; reason: string }[] = [];
  const first: number[] = [];
  for (const [index, hash] of hashes.entries()) {
    const [memberRaw, currentRaw, snapshotRaw, conflictRaw] = files.slice(index * 4, index * 4 + 4);
    if (!memberRaw) throw new HttpError(502, `Batch member ${hash} is unreadable`);
    const member = batchMemberSchema.parse(memberRaw.value);
    if (member.hash !== hash) throw new HttpError(502, 'Stored member hash mismatch');
    members.push(member);
    if (conflictRaw) blocked.push({ hash, reason: 'Resolve the batch activation first' });
    const current = currentRaw ? tooltipSchema.parse(currentRaw.value) : null;
    const snapshot = snapshotRaw ? tooltipSchema.parse(snapshotRaw.value) : null;
    snapshots.set(hash, snapshot);
    const result = compose({
      hash,
      base: member.base,
      proposed: member.proposed,
      snapshot,
      pushed: pushed.has(hash),
    });
    if (result.status === 'stale') {
      stale.push({ hash, reason: result.reason });
      continue;
    }
    // Root ruling after P1: batch fields carrying saved-but-unpublished work are refused (I3).
    if (result.status === 'overlay' && result.unpublished.length)
      unpublished.push({ hash, fields: result.unpublished });
    if (result.status === 'whole') first.push(hash);
    // Non-translation merge3 must be clean against current (R14 existence rule included);
    // translations follow Q4 and never block.
    const activation = activate({ base: member.base, current, proposed: member.proposed });
    if (!activation.ok)
      stale.push({
        hash,
        fields: activation.fields,
        ...(activation.reason ? { reason: activation.reason } : {}),
      });
    composed.push(result.tooltip);
  }
  if (blocked.length) refuseScheduleMembers('Resolve the batch activation first', blocked);
  if (stale.length)
    refuseScheduleMembers('Current changed under this batch; rebase the listed tooltips', stale);
  if (unpublished.length) refuseScheduleMembers(unpublishedMessage, unpublished);
  return { members, composed, snapshots, first };
}
