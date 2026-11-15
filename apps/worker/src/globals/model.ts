import { z } from 'zod';
import { langSchema } from '../../../../packages/core/src/languages.js';
import {
  globalConsumerSchema,
  globalDigestSchema,
  globalIdSchema,
  globalKindSchema,
  globalRecordSchema,
  globalReviewSchema,
  globalRevisionSchema,
} from '../../../../packages/core/src/globals/model.js';
import { globalImpactRowSchema } from '../../../../packages/core/src/globals/impactModel.js';

export const limits = {
  requestBytes: 16_384,
  fileBytes: 65_536,
  entryBytes: 16_384,
  body: 8_192,
  causes: 32,
  page: 3,
};
export const oid = z.string().regex(/^[a-f0-9]{40}$/);
const token = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
/** Observed by the authenticated integrator, never supplied by the HTTP client.
 * Every generic writer must change a checked identity or invalidate the certificate.
 * authored is the tooltips tree; definitions and projections are their separate trees,
 * and config covers all data-side resolver settings. Do not use the repository root
 * tree: writing a certificate would invalidate itself. Permissions are re-read at head
 * separately. upcoming covers every scheduled source, even disabled ones.
 */
export const sourcesSchema = z
  .object({
    authored: oid,
    definitions: oid,
    projections: oid,
    config: oid,
    live: oid,
    upcoming: oid,
    aliases: oid,
    generator: oid,
    fallback: globalDigestSchema,
    resolver: globalDigestSchema,
  })
  .strict();
export type Sources = z.infer<typeof sourcesSchema>;

const sourceIdentity = z
  .object({ path: z.string().max(256), blob: oid, revision: globalRevisionSchema })
  .strict();
export const pendingCauseSchema = z
  .object({
    version: z.literal(1),
    id: token,
    operation: z.enum(['create', 'edit', 'rename', 'remove']),
    globalId: globalIdSchema,
    lang: langSchema.nullable(),
    beforeSources: sourcesSchema,
    expectedHead: oid,
    at: z.iso.datetime(),
    by: z.string().min(1).max(128),
    before: sourceIdentity.nullable(),
    after: sourceIdentity,
    intentId: token.nullable(),
  })
  .strict();

export const syncSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['sync-pending', 'sync-failed', 'current']),
    causeIds: z.array(token).max(limits.causes),
    lastFailure: z.string().max(512).nullable(),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.causeIds).size === v.causeIds.length &&
      (v.status === 'current'
        ? v.causeIds.length === 0 && v.lastFailure === null
        : v.causeIds.length > 0) &&
      (v.status !== 'sync-failed' || v.lastFailure !== null),
    'Invalid Sync pending state',
  );
export type SyncState = z.infer<typeof syncSchema>;

export const entrySchema = globalRecordSchema.superRefine((entry, ctx) => {
  if (
    entry.name.length > 128 ||
    entry.nameHistory.length > 32 ||
    Object.values(entry.definitions).some((d) => d.body.length > limits.body)
  )
    ctx.addIssue({ code: 'custom', message: 'Global entry exceeds admission limits' });
});
const proof = { version: z.literal(1), complete: z.literal(true), sources: sourcesSchema };
export const clashSchema = z
  .object({
    ...proof,
    kind: globalKindSchema,
    name: z.string().max(128),
    occupiedBy: globalIdSchema.nullable(),
    localClash: z.literal(false),
    // The producer must evaluate effective fallback, unresolved reads, and title preparation.
    coverage: z.literal('authored-live-upcoming-fallback'),
  })
  .strict();
export const removalSchema = z
  .object({
    ...proof,
    id: globalIdSchema,
    revision: globalRevisionSchema,
    lang: langSchema.nullable(),
    references: z
      .object({
        authored: z.literal(0),
        effective: z.literal(0),
        live: z.literal(0),
        upcoming: z.literal(0),
        unresolved: z.literal(0),
        conservativeTitles: z.literal(0),
      })
      .strict(),
  })
  .strict();
export const rowSchema = z
  .object({
    ...proof,
    id: token,
    review: globalReviewSchema,
    impactDigest: globalDigestSchema,
    projected: z.literal(false),
    view: globalImpactRowSchema
      .extend({
        variant: z.number().int().nonnegative(),
        name: z.string().max(256),
        category: z.string().max(128),
        line: z.number().int().positive().nullable(),
        path: z.array(z.string().max(128)).max(32).nullable(),
        direct: z.boolean().nullable(),
        archived: z.boolean(),
        beforeSource: z.string().max(8192),
        afterSource: z.string().max(8192),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.review.causes.length <= limits.causes &&
      JSON.stringify(v.review.consumer) === JSON.stringify(v.view.consumer) &&
      JSON.stringify(v.review.causes) === JSON.stringify(v.view.causes),
    'Review manifest mismatch',
  );
export const publicationSchema = z
  .object({
    ...proof,
    consumer: globalConsumerSchema,
    causeIds: z.array(token).max(limits.causes),
    independent: z.boolean(),
    // Offline producer has checked all current ledger acknowledgements and resolver blockers.
    approved: z.literal(true),
  })
  .strict();
export const pageSchema = z
  .object({
    version: z.literal(1),
    ids: z.array(globalIdSchema).max(limits.page),
    nextCursor: token.nullable(),
  })
  .strict();
export const catalogSchema = z
  .object({ version: z.literal(1), lastPage: z.number().int().min(0).max(99999) })
  .strict();
export const reviewPageSchema = z
  .object({ ...proof, ids: z.array(token).max(limits.page), nextCursor: token.nullable() })
  .strict();

const expected = { expectedHead: oid };
const existing = { id: globalIdSchema, revision: globalRevisionSchema };
const definition = { lang: langSchema, body: z.string().max(limits.body) };
export const mutationSchema = z
  .object({
    ...expected,
    mutation: z.discriminatedUnion('operation', [
      z
        .object({
          operation: z.literal('create'),
          kind: globalKindSchema,
          name: z.string().min(1).max(128),
          ...definition,
        })
        .strict(),
      z.object({ operation: z.literal('edit'), ...existing, ...definition }).strict(),
      z
        .object({ operation: z.literal('rename'), ...existing, name: z.string().min(1).max(128) })
        .strict(),
      z
        .object({ operation: z.literal('remove'), ...existing, lang: langSchema.optional() })
        .strict(),
      z
        .object({
          operation: z.literal('acknowledge'),
          id: globalIdSchema,
          consumerId: token,
          contentDigest: globalDigestSchema,
          dependencyDigest: globalDigestSchema,
          impactDigest: globalDigestSchema,
          decision: z.literal('no-text-change'),
        })
        .strict(),
    ]),
  })
  .strict();
export type Mutation = z.infer<typeof mutationSchema>['mutation'];

export const paths = {
  sync: 'globals/sync.json',
  entry: (id: string) => `globals/entries/${id}.json`,
  row: (id: string) => `globals/reviews/${id}.json`,
  page: (cursor: string) => `globals/pages/${cursor}.json`,
  removal: (id: string, lang?: string) => `globals/proofs/removal/${id}-${lang ?? 'all'}.json`,
};

export function sameSources(a: Sources, b: Sources): boolean {
  return (Object.keys(a) as (keyof Sources)[]).every((key) => a[key] === b[key]);
}
