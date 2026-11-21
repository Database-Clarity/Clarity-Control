import { z } from 'zod';
import { stableStringify } from '../contentHash.js';
import { publishOpIdSchema } from '../publishRequest.js';
import { timestampSchema } from '../schemas.js';
import { notBeforeSchema } from './schemas.js';

/** Installed only after the Action preparer AND publisher claim fence are present. */
export const schedulePreparationCapability = 'schedulePreparationV1';
export const draftBatchStagingCapability = 'draftBatchStagingV1';
export const scheduledBatchStagingCapability = 'scheduledBatchStagingV1';
/** Bounded staging request, measured independently of the batch's membership. */
export const preparedDraftSave = { changes: 100, bytes: 96 * 1024 } as const;
const stagedPartsPrefix = (batchId: string, id: string) =>
  `schedule/batches/${batchId}/staged/${id}/`;
export const draftStagingInputSchema = z
  .object({ id: publishOpIdSchema, finish: z.boolean() })
  .strict();
export type DraftStagingInput = z.infer<typeof draftStagingInputSchema>;
export const scheduleIntentPaths = {
  request: (id: string) => `schedule/requests/${id}.json`,
  body: (id: string) => `schedule/requests/${id}.body.json`,
  publication: (batchId: string) => `schedule/batches/${batchId}/publication.json`,
  stagedSave: (batchId: string) => `schedule/batches/${batchId}/staged-save.json`,
  stagedPartsPrefix,
  stagedPart: (batchId: string, id: string, part: number) =>
    `${stagedPartsPrefix(batchId, id)}${part}.json`,
} as const;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const oid = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const scheduledStagingSchema = z
  .object({
    id: publishOpIdSchema,
    ownerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revision,
    parts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ready: z.boolean(),
    updatedAt: timestampSchema,
  })
  .strict();
export type ScheduledStaging = z.infer<typeof scheduledStagingSchema>;
const common = {
  version: z.literal(1),
  requestId: publishOpIdSchema,
  batchId: publishOpIdSchema,
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  dataBranch: z.string().min(1).max(255),
  liveBranch: z.string().min(1).max(255),
  requester: z
    .object({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      login: z.string().min(1).max(39),
    })
    .strict(),
  expectedRevision: revision,
  contentRevision: revision,
  sourceCommit: oid,
  /** Null only when the source batch has no members yet (a draft save). */
  memberTreeOid: oid.nullable(),
  createdAt: timestampSchema,
  /** SHA-256 of the exact UTF-8 HTTP request bytes; the Worker computes it. */
  bodyDigest: digest,
};
export const scheduleIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('schedule'),
      notBefore: notBeforeSchema,
      zone: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('save'),
      returnStatus: z.enum(['draft', 'scheduled']),
      /** Worker-derived owner policy; clients cannot select this field. */
      onValidationFailure: z.enum(['keep_scheduled', 'needs_attention']),
      draftStaging: draftStagingInputSchema.optional(),
      /** Each part is read from this intent's immutable sourceCommit. */
      scheduledParts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict()
    .refine(
      (intent) =>
        intent.onValidationFailure !== 'keep_scheduled' || intent.returnStatus === 'scheduled',
      'Only an existing schedule can survive a failed save',
    )
    .refine(
      (intent) => !intent.draftStaging || intent.returnStatus === 'draft',
      'Only a draft batch can have an unfinished save',
    )
    .refine(
      (intent) => !intent.scheduledParts || intent.returnStatus === 'scheduled',
      'Staged scheduled edits require an accepted schedule',
    ),
]);
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;
export const scheduleEnvelopeSchema = z
  .object({ payload: z.string().max(4096), sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
  .strict();
export type ScheduleEnvelope = z.infer<typeof scheduleEnvelopeSchema>;
export const preparationReasonSchema = z
  .object({
    reason: z.string().min(1).max(2000),
    hash: z.number().int().nonnegative().max(0xffffffff).optional(),
    fields: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .strict();
export const scheduleRequestSchema = z
  .object({
    envelope: scheduleEnvelopeSchema,
    requestId: publishOpIdSchema,
    batchId: publishOpIdSchema,
    requesterId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bodyDigest: digest,
    admissionRevision: revision,
    status: z.enum(['pending', 'needs_attention', 'failed', 'completed', 'cancelled']),
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    updatedAt: timestampSchema,
    retryable: z.boolean().optional(),
    reasons: z.array(preparationReasonSchema).max(100).optional(),
    workflowUrl: z.string().url().max(2000).optional(),
    /** Result is set only by the preparer, after its materialization CAS. */
    result: z
      .object({ revision, contentRevision: revision, status: z.enum(['draft', 'scheduled']) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.status === 'failed' && (!request.reasons?.length || request.result !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'A failed request has reasons and no successful save result',
      });
  });
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;

export async function scheduleBodyDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function signScheduleIntent(
  intent: ScheduleIntent,
  key: CryptoKey,
): Promise<ScheduleEnvelope> {
  const payload = stableStringify(scheduleIntentSchema.parse(intent));
  const sig = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload)),
      ),
    ),
  );
  return { payload, sig };
}

/** Verify before trusting any source, target, or submitted save bytes. */
export async function verifyScheduleIntent(
  envelope: ScheduleEnvelope,
  key: CryptoKey,
): Promise<ScheduleIntent> {
  const checked = scheduleEnvelopeSchema.parse(envelope);
  const signature = Uint8Array.from(atob(checked.sig), (char) => char.charCodeAt(0));
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      signature,
      new TextEncoder().encode(checked.payload),
    ))
  )
    throw new Error('Invalid schedule intent signature');
  return scheduleIntentSchema.parse(JSON.parse(checked.payload));
}

/** Verify the storage wrapper, target, and exact submitted bytes before offline validation. */
export async function verifyScheduleRequest(
  value: unknown,
  body: Uint8Array,
  key: CryptoKey,
  target: Pick<ScheduleIntent, 'repo' | 'dataBranch' | 'liveBranch'>,
): Promise<{ request: ScheduleRequest; intent: ScheduleIntent }> {
  const request = scheduleRequestSchema.parse(value);
  const intent = await verifyScheduleIntent(request.envelope, key);
  if (
    intent.repo !== target.repo ||
    intent.dataBranch !== target.dataBranch ||
    intent.liveBranch !== target.liveBranch ||
    intent.requestId !== request.requestId ||
    intent.batchId !== request.batchId ||
    intent.requester.id !== request.requesterId ||
    intent.bodyDigest !== request.bodyDigest ||
    (await scheduleBodyDigest(body)) !== intent.bodyDigest
  )
    throw new Error('Schedule request does not match its signed intent');
  return { request, intent };
}
