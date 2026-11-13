import { z } from 'zod';
import { stableStringify } from '../contentHash.js';
import { hashSchema } from '../legacy.js';
import { publishOpIdSchema, publishPayloadSchema } from '../publishRequest.js';
import { type Tooltip } from '../schemas.js';
import { withoutTranslations } from './fields.js';
import { batchIdSchema, notBeforeSchema, scheduleLimits } from './schemas.js';

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface DigestMember {
  hash: number;
  base: Tooltip | null;
  proposed: Tooltip;
}

/**
 * The canonical text approvedDigest hashes: the member list (sorted by hash) with each member's
 * full base (which only add and rebase set) and its proposal WITHOUT translations (every
 * non-translation key, English included, exact values with stamps). Translation saves never
 * change it; membership, any rebase that moves a base, and any other field change do (I5).
 * Exposed for contentRevision (revisions.ts), which bumps exactly when it changes.
 */
export function approvalInput(members: readonly DigestMember[]): string {
  const sorted = [...members].sort((a, b) => a.hash - b.hash);
  for (const [index, member] of sorted.entries()) {
    if (index > 0 && sorted[index - 1].hash === member.hash)
      throw new Error(`Duplicate member ${member.hash}`);
    if (member.proposed.hash !== member.hash || (member.base && member.base.hash !== member.hash))
      throw new Error(`Member ${member.hash} carries another hash`);
  }
  return stableStringify({
    v: 1,
    members: sorted.map((member) => ({
      hash: member.hash,
      base: member.base,
      proposed: withoutTranslations(member.proposed),
    })),
  });
}

/** SHA-256 hex of approvalInput: what the signed batch request carries (I5). */
export function approvedDigest(members: readonly DigestMember[]): Promise<string> {
  return sha256(approvalInput(members));
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const pushShape = publishPayloadSchema.shape;

/**
 * Request `publish/requests/<opId>.json` of kind `batch` (spec "Data model"). Phase P4 joins it
 * with the `push` payload in publishRequest.ts as a discriminated union; the `push` payload and
 * its intent digest stay byte-identical (golden in schedule.test.ts).
 */
export const batchPublishPayloadSchema = z
  .object({
    kind: z.literal('batch'),
    opId: publishOpIdSchema,
    repo: pushShape.repo,
    dataBranch: pushShape.dataBranch,
    liveBranch: pushShape.liveBranch,
    requester: pushShape.requester,
    createdAt: pushShape.createdAt,
    batchId: batchIdSchema,
    contentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    notBefore: notBeforeSchema,
    hashes: z
      .array(hashSchema)
      .min(1)
      .max(scheduleLimits.membersPerBatch)
      .refine(
        (list) => list.every((hash, index) => index === 0 || list[index - 1] < hash),
        'Hashes must be sorted and unique',
      ),
    approvedDigest: digestSchema,
    intentDigest: digestSchema,
  })
  .strict();
export type BatchPublishPayload = z.infer<typeof batchPublishPayloadSchema>;
export type BatchPublishIntent = Omit<BatchPublishPayload, 'createdAt' | 'intentDigest'>;

/**
 * Intent digest of a batch request: binds every intent field except the server clock and the
 * requester's login (as publishIntentDigest does for `push`).
 */
export function batchIntentDigest(value: BatchPublishIntent): Promise<string> {
  return sha256(
    stableStringify({
      opId: value.opId,
      kind: value.kind,
      repo: value.repo,
      dataBranch: value.dataBranch,
      liveBranch: value.liveBranch,
      requester: { id: value.requester.id },
      batchId: value.batchId,
      contentRevision: value.contentRevision,
      notBefore: value.notBefore,
      hashes: [...value.hashes].sort((a, b) => a - b),
      approvedDigest: value.approvedDigest,
    }),
  );
}
