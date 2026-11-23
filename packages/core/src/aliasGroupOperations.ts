import { z } from 'zod';
import { hashSchema } from './legacy.js';

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const members = z
  .array(hashSchema)
  .min(2)
  .max(256)
  .refine((v) => new Set(v).size === v.length);
const selection = {
  canonical: hashSchema,
  members,
  /** Compare with server-recomputed membership/facts digest, never trust client eligibility. */
  factsDigest: digest,
  /** Single-group only. Server still refuses loss of a locale absent from canonical text. */
  acknowledgeConflicts: z.literal(true).optional(),
  note: z.string().max(500).optional(),
};

/** Client intent only: actor, time, archives, basis, and eligibility are server-derived.
 * Split accepts a subset of a proposal, subject to exactly the same rules as accept.
 * Multiple accept/split operations require server-proven identical wording and no text conflicts.
 * Canonical always selects an existing member's complete tooltip; no text is synthesized.
 */
export const aliasGroupOperationSchema = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('accept'), ...selection }).strict(),
    z.object({ op: z.literal('split'), ...selection }).strict(),
    z
      .object({
        op: z.literal('reject'),
        members,
        factsDigest: digest,
        reason: z.string().max(500).optional(),
      })
      .strict(),
    z.object({ op: z.literal('ungroup'), canonical: hashSchema }).strict(),
    z
      .object({
        op: z.literal('setCanonical'),
        canonical: hashSchema,
        to: hashSchema,
        acknowledgeConflicts: z.literal(true).optional(),
      })
      .strict(),
    /** One non-canonical member leaves; it starts as a copy of the group's current tooltip. */
    z.object({ op: z.literal('removeMember'), canonical: hashSchema, member: hashSchema }).strict(),
  ])
  .superRefine((op, ctx) => {
    if ((op.op === 'accept' || op.op === 'split') && !op.members.includes(op.canonical))
      ctx.addIssue({ code: 'custom', message: 'Canonical must be a selected member' });
    if (op.op === 'setCanonical' && op.canonical === op.to)
      ctx.addIssue({ code: 'custom', message: 'Canonical must change' });
    if (op.op === 'removeMember' && op.canonical === op.member)
      ctx.addIssue({ code: 'custom', message: 'The main entry cannot leave its own group' });
  });
export type AliasGroupOperation = z.infer<typeof aliasGroupOperationSchema>;

/** CAS applies to the entire atomic batch. A stale head or facts digest is never rebased. */
export const aliasGroupsRequestSchema = z
  .object({
    expectedHead: commit,
    ops: z.array(aliasGroupOperationSchema).min(1).max(100),
  })
  .strict();
export type AliasGroupsRequest = z.infer<typeof aliasGroupsRequestSchema>;
