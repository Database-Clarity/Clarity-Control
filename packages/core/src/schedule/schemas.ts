import { z } from 'zod';
import { hashSchema } from '../legacy.js';
import { publishOpIdSchema } from '../publishRequest.js';
import { timestampSchema, tooltipSchema } from '../schemas.js';
import { changedFields } from './fields.js';

/** Bounds from spec "Free-plan budget" (R7, R13). */
export const scheduleLimits = {
  /** Open = draft, scheduled, or publishing; checked at create and at every return to draft. */
  openBatches: 50,
  membersPerBatch: 100,
  /** Terminal (published, cancelled) entries kept in index.json besides the open ones. */
  indexTerminal: 100,
  /** Inline events per batch.json; older ones move to events/<seq>.json in the same commit. */
  inlineEvents: 200,
  nameLength: 80,
  /** notBefore must be at least this far ahead (or 'now'). */
  minLeadMs: 3 * 60_000,
  /** ...and at most this far ahead. */
  maxLeadMs: 366 * 86_400_000,
  /** A non-terminal batch this long past notBefore is overdue (Kick). */
  overdueMs: 5 * 60_000,
} as const;

/** editor-data paths (spec "Data model"). */
export const schedulePaths = {
  batch: (batchId: string) => `schedule/batches/${batchId}/batch.json`,
  member: (batchId: string, hash: number) => `schedule/batches/${batchId}/tooltips/${hash}.json`,
  due: 'schedule/due.json',
  index: 'schedule/index.json',
  conflict: (hash: number) => `schedule/activation-conflicts/${hash}.json`,
  conflictsDir: 'schedule/activation-conflicts',
} as const;

/** A batch id is a ULID, the same shape as a publish opId. */
export const batchIdSchema = publishOpIdSchema;
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const userSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: z.string().min(1).max(39),
  })
  .strict();
const sortedUniqueHashes = (max: number) =>
  z
    .array(hashSchema)
    .max(max)
    .refine(
      (list) => list.every((hash, index) => index === 0 || list[index - 1] < hash),
      'Hashes must be sorted and unique',
    );

/**
 * A UTC instant on a whole minute, in its one canonical form `YYYY-MM-DDTHH:MM:00.000Z`
 * (`Date.prototype.toISOString`), so string order is time order.
 */
export const notBeforeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, 'Not a real UTC minute');

export const batchStatusSchema = z.enum([
  'draft',
  'scheduled',
  'publishing',
  'published',
  'cancelled',
]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;
export const openStatuses: readonly BatchStatus[] = ['draft', 'scheduled', 'publishing'];
export const isOpenStatus = (status: BatchStatus) => openStatuses.includes(status);

export const batchResultStatusSchema = z.enum([
  'published',
  'unchanged',
  'stale',
  'rejected',
  'superseded',
]);
export const batchEventActionSchema = z.enum([
  'create',
  'rename',
  'save',
  'rebase',
  'remove',
  'schedule',
  'reschedule',
  'unschedule',
  'cancel',
  'claim',
  'published',
  'unchanged',
  'stale',
  'rejected',
  'superseded',
  'resolve',
]);

export const batchEventSchema = z
  .object({
    at: timestampSchema,
    by: userSchema,
    action: batchEventActionSchema,
    /** The batch's revisions AFTER this write. */
    revision: revisionSchema,
    contentRevision: revisionSchema,
    notBefore: notBeforeSchema.optional(),
    hashes: z.array(hashSchema).max(scheduleLimits.membersPerBatch).optional(),
  })
  .strict();

export const batchResultSchema = z
  .object({
    opId: publishOpIdSchema,
    status: batchResultStatusSchema,
    /** Publisher clock when the live CAS was confirmed ('cas') or first observed ('observed'). */
    landedAt: timestampSchema.optional(),
    landedAtSource: z.enum(['cas', 'observed']).optional(),
    /** RECORD commit clock. */
    recordedAt: timestampSchema.optional(),
    /** receipt.now: the export stamping time, never shown as completion. */
    exportNow: timestampSchema.optional(),
    liveCommit: commitSchema.optional(),
    /** Per-hash outcomes as the publisher logs them (stale fields, missing, and so on). */
    outcomes: z
      .array(z.looseObject({ hash: hashSchema, status: z.string().min(1) }))
      .max(scheduleLimits.membersPerBatch)
      .optional(),
    /** Reason for a rejected or superseded operation ("Last run failed: <reason>"). */
    error: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.landedAt === undefined) !== (value.landedAtSource === undefined))
      ctx.addIssue({ code: 'custom', message: 'landedAt and landedAtSource go together' });
    const landed = value.status === 'published' || value.status === 'unchanged';
    if (!landed && (value.landedAt || value.liveCommit))
      ctx.addIssue({ code: 'custom', message: 'Only a published result has a landing' });
  });

/** schedule/batches/<batchId>/batch.json */
export const batchSchema = z
  .object({
    id: batchIdSchema,
    name: z
      .string()
      .min(1)
      .max(scheduleLimits.nameLength)
      .refine((name) => name.trim() === name, 'Name has surrounding spaces'),
    createdBy: userSchema,
    createdAt: timestampSchema,
    /** +1 on EVERY write to the batch; clients send it as their CAS expectation. */
    revision: revisionSchema,
    /** +1 only when approvedDigest's input changes (see revisions.ts). */
    contentRevision: revisionSchema,
    status: batchStatusSchema,
    notBefore: notBeforeSchema.nullable(),
    /** IANA zone the time was chosen in; display only. */
    zone: z.string().min(1).max(64).nullable(),
    opId: publishOpIdSchema.nullable(),
    scheduledContentRevision: revisionSchema.nullable(),
    /** Set only by the publisher's claim commit; kept as history once published. */
    claim: z.object({ opId: publishOpIdSchema, claimedAt: timestampSchema }).strict().nullable(),
    /** The latest operation's result. */
    result: batchResultSchema.nullable(),
    events: z.array(batchEventSchema).max(scheduleLimits.inlineEvents),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (batch.contentRevision > batch.revision) issue('contentRevision exceeds revision');
    if (
      batch.scheduledContentRevision !== null &&
      batch.scheduledContentRevision > batch.contentRevision
    )
      issue('scheduledContentRevision exceeds contentRevision');
    switch (batch.status) {
      case 'draft':
      case 'cancelled':
        if (batch.opId !== null || batch.claim !== null || batch.scheduledContentRevision !== null)
          issue(`A ${batch.status} batch has no operation or claim`);
        break;
      case 'scheduled':
        if (
          batch.opId === null ||
          batch.notBefore === null ||
          batch.scheduledContentRevision === null
        )
          issue('A scheduled batch needs opId, notBefore, and scheduledContentRevision');
        if (batch.claim !== null) issue('A scheduled batch is unclaimed');
        break;
      case 'publishing':
      case 'published':
        if (
          batch.opId === null ||
          batch.notBefore === null ||
          batch.scheduledContentRevision === null
        )
          issue(`A ${batch.status} batch needs opId, notBefore, and scheduledContentRevision`);
        if (batch.claim === null || batch.claim.opId !== batch.opId)
          issue(`A ${batch.status} batch is claimed by its own opId`);
        if (batch.status === 'published') {
          if (
            batch.result?.opId !== batch.opId ||
            (batch.result.status !== 'published' && batch.result.status !== 'unchanged')
          )
            issue('A published batch carries its own published result');
        }
        break;
    }
    if (
      batch.result &&
      batch.opId !== null &&
      batch.status !== 'published' &&
      batch.result.opId === batch.opId
    )
      issue('A pending operation has no result yet');
  });
export type Batch = z.infer<typeof batchSchema>;

/** schedule/batches/<batchId>/tooltips/<hash>.json (canonical hashes only). */
export const batchMemberSchema = z
  .object({
    hash: hashSchema,
    /** Current saved at add or rebase; null for a tooltip the batch creates. */
    base: tooltipSchema.nullable(),
    baseCommit: commitSchema,
    proposed: tooltipSchema,
    updatedAt: timestampSchema,
    updatedBy: z.string().min(1),
  })
  .strict()
  .superRefine((member, ctx) => {
    if (member.proposed.hash !== member.hash || (member.base && member.base.hash !== member.hash))
      ctx.addIssue({ code: 'custom', message: 'Member tooltips must carry the member hash' });
  });
export type BatchMember = z.infer<typeof batchMemberSchema>;

/** schedule/due.json: every scheduled batch and every claimed batch until its terminal record. */
export const dueSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            batchId: batchIdSchema,
            opId: publishOpIdSchema,
            notBefore: notBeforeSchema,
            claimed: z.boolean(),
          })
          .strict(),
      )
      .max(scheduleLimits.openBatches),
  })
  .strict()
  .superRefine((due, ctx) => {
    const ids = due.entries.map((entry) => entry.batchId);
    const ops = due.entries.map((entry) => entry.opId);
    if (new Set(ids).size !== ids.length || new Set(ops).size !== ops.length)
      ctx.addIssue({ code: 'custom', message: 'One due entry per batch and per opId' });
  });
export type Due = z.infer<typeof dueSchema>;

/** schedule/index.json: derived UI list, repairable from batch.json, never a guard. */
export const scheduleIndexSchema = z
  .object({
    batches: z
      .array(
        z
          .object({
            id: batchIdSchema,
            name: batchSchema.shape.name,
            status: batchStatusSchema,
            notBefore: notBeforeSchema.nullable(),
            opId: publishOpIdSchema.nullable(),
            revision: revisionSchema,
            hashes: sortedUniqueHashes(scheduleLimits.membersPerBatch),
            updatedAt: timestampSchema,
          })
          .strict(),
      )
      .max(scheduleLimits.openBatches + scheduleLimits.indexTerminal),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = index.batches.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate batch id' });
    const open = index.batches.filter((entry) => isOpenStatus(entry.status)).length;
    if (open > scheduleLimits.openBatches)
      ctx.addIssue({ code: 'custom', message: 'Too many open batches' });
    if (index.batches.length - open > scheduleLimits.indexTerminal)
      ctx.addIssue({ code: 'custom', message: 'Too many terminal batches' });
  });
export type ScheduleIndex = z.infer<typeof scheduleIndexSchema>;

/**
 * schedule/activation-conflicts/<hash>.json: authoritative, never expires; only the resolve
 * route removes it. `fields` = the conflicted fields at RECORD; `changed` = ALL the member's
 * batch-changed fields (spec "Publication path" 6), always changedFields(base, proposed).
 */
export const activationConflictSchema = z
  .object({
    hash: hashSchema,
    batchId: batchIdSchema,
    opId: publishOpIdSchema,
    fields: z.array(z.string().min(1)).min(1),
    changed: z.array(z.string().min(1)),
    base: tooltipSchema.nullable(),
    proposed: tooltipSchema,
    currentAtRecord: tooltipSchema.nullable(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const tooltip of [file.base, file.proposed, file.currentAtRecord])
      if (tooltip && tooltip.hash !== file.hash)
        issue('Conflict tooltips must carry the file hash');
    if (file.proposed.hash !== file.hash) return;
    const changed = changedFields(file.base, file.proposed);
    if (changed.join('\n') !== file.changed.join('\n'))
      issue('changed must equal the batch-changed fields');
    if (!file.fields.every((field) => field === '$exists' || changed.includes(field)))
      issue('Conflicted fields must be batch-changed fields');
  });
export type ActivationConflict = z.infer<typeof activationConflictSchema>;
