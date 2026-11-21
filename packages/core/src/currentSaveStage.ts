import { z } from 'zod';
import { publishOpIdSchema } from './publishRequest.js';
import { timestampSchema } from './schemas.js';

export const currentSaveStagingCapability = 'currentSaveStagingV1';
export const currentSavePartBytes = 32 * 1024;
export const currentSaveMaxParts = 512;
export const currentSaveStartsPerHour = 30;
export const currentSaveStartWindow = 60 * 60_000;
export const currentSaveStageLifetime = 24 * 60 * 60_000;
export const currentSaveSha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const partCount = ordinal.min(1).max(currentSaveMaxParts);
const requester = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/i),
  })
  .strict();
export const currentSaveStageInput = z.union([
  z
    .object({
      requestId: publishOpIdSchema,
      part: ordinal,
      content: z
        .string()
        .min(4)
        .max(Math.ceil(currentSavePartBytes / 3) * 4)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/)
        .refine(
          (content) =>
            content.length % 4 === 0 &&
            (content.length / 4) * 3 -
              (content.endsWith('==') ? 2 : Number(content.endsWith('='))) <=
              currentSavePartBytes,
        ),
    })
    .strict(),
  z.object({ requestId: publishOpIdSchema, parts: ordinal.min(1), digest }).strict(),
]);
export const currentSaveIntent = z
  .object({
    version: z.literal(1),
    requestId: publishOpIdSchema,
    requester,
    repo: z.string(),
    branch: z.string(),
    sourceCommit: currentSaveSha,
    parts: partCount,
    digest,
  })
  .strict();
const envelope = z
  .object({
    payload: z.string().max(4096),
    sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const record = z.object({ requester, updatedAt: timestampSchema }).strict();
const outcome = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    commit: currentSaveSha,
    savedAt: z.number().int().positive(),
  }),
  z.object({ status: z.literal('conflicts'), head: currentSaveSha }),
  z.object({ status: z.literal('failed'), error: z.string().max(2000) }),
  z.object({ status: z.literal('queued') }),
]);
export const currentSaveOutcome = outcome;
export const currentSaveStageRecord = z.discriminatedUnion('status', [
  record.extend({ status: z.literal('uploading'), parts: partCount }),
  record.extend({ status: z.literal('queued'), envelope, parts: partCount }),
  record.extend({
    status: z.literal('saved'),
    commit: currentSaveSha,
    savedAt: z.number().int().positive(),
  }),
  record.extend({ status: z.literal('conflicts') }),
  record.extend({ status: z.literal('failed'), error: z.string().max(2000) }),
]);

export type CurrentSaveStageRecord = z.infer<typeof currentSaveStageRecord>;
export const currentSaveUploadUsage = z
  .object({
    active: z.object({ requestId: publishOpIdSchema, parts: partCount }).strict().nullable(),
    starts: z.array(ordinal).max(currentSaveStartsPerHour),
  })
  .strict();
export const currentSavePath = 'current-saves/';
export const currentSaveStagePaths = {
  prefix: (id: string) => `${currentSavePath}${id}/`,
  record: (id: string) => `${currentSavePath}${id}/request.json`,
  part: (id: string, part: number) => `${currentSavePath}${id}/${part}.json`,
  conflicts: (id: string) => `${currentSavePath}${id}/conflicts.json`,
  kick: (id: string) => `publish/kicks/current-save-${id}.json`,
  usage: (requesterId: number) => `${currentSavePath}requesters/${requesterId}.json`,
};
