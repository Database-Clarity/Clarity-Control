import { z } from 'zod';
import { hashSchema } from './legacy.js';
import { stableStringify } from './contentHash.js';

export const publishOpIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const hashKey = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((s) => Number(s) <= 0xffffffff);
export const publishBodySchema = z
  .object({
    opId: publishOpIdSchema,
    hashes: z
      .array(hashSchema)
      .min(1)
      .max(3000)
      .refine((a) => new Set(a).size === a.length),
    expected: z.record(hashKey, digest),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Object.keys(v.expected).length !== v.hashes.length || v.hashes.some((h) => !v.expected[h]))
      ctx.addIssue({ code: 'custom', message: 'Exactly one expected digest per hash is required' });
  });
export const publishPayloadSchema = z
  .object({
    ...publishBodySchema.shape,
    kind: z.literal('push'),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    dataBranch: z.string().min(1),
    liveBranch: z.string().min(1),
    requester: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        login: z.string().min(1),
      })
      .strict(),
    createdAt: z.string().datetime(),
    intentDigest: digest,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !publishBodySchema.safeParse({ opId: v.opId, hashes: v.hashes, expected: v.expected }).success
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid publish intent' });
  });
export type PublishPayload = z.infer<typeof publishPayloadSchema>;
export type PublishIntent = Omit<PublishPayload, 'createdAt' | 'intentDigest'>;
/** Apply to a single fresh head, log before request. Used on ALL create errors, too. */
export function classifyPublishIntent(
  intentDigest: string,
  request?: { intentDigest: string },
  log?: { intentDigest: string; result: unknown },
) {
  const existing = log ?? request;
  if (existing && existing.intentDigest !== intentDigest) return { status: 'conflict' as const };
  if (log) return { status: 'complete' as const, result: log.result };
  if (request) return { status: 'pending' as const };
  return { status: 'create' as const };
}
export async function publishIntentDigest(value: PublishIntent): Promise<string> {
  const bytes = new TextEncoder().encode(
    stableStringify({
      opId: value.opId,
      kind: value.kind,
      repo: value.repo,
      dataBranch: value.dataBranch,
      liveBranch: value.liveBranch,
      requester: { id: value.requester.id },
      hashes: [...value.hashes].sort((a, b) => a - b),
      expected: value.expected,
    }),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export function publishMonth(opId: string): string {
  publishOpIdSchema.parse(opId);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const time = [...opId.slice(0, 10)].reduce((n, c) => n * 32 + alphabet.indexOf(c), 0);
  return new Date(time).toISOString().slice(0, 7);
}
export function validatePublishBody(value: unknown, now: number, creating = true) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 300 * 1024)
    throw new Error('Publish body exceeds 300 KB');
  const parsed = publishBodySchema.parse(value);
  if (creating) {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = [...parsed.opId.slice(0, 10)].reduce((n, c) => n * 32 + alphabet.indexOf(c), 0);
    if (Math.abs(time - now) > 86_400_000) throw new Error('Publish opId outside creation window');
  }
  return parsed;
}
