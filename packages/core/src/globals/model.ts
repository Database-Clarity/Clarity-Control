import { z } from 'zod';
import { langSchema } from '../languages.js';
import { hashSchema } from '../legacy.js';
import { langTextSchema, timestampSchema, tooltipSchema } from '../schemas.js';
import { extractBlocks } from '../markup/syntax.js';

/** Opaque identity: never derived from a reference name, language, or Bungie hash. */
export const globalIdSchema = z.string().regex(/^g_[a-zA-Z0-9_-]{8,80}$/);
export const globalRevisionSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const globalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const globalKindSchema = z.enum(['variables', 'titles']);

export function validGlobalName(kind: 'variables' | 'titles', name: string): boolean {
  if (kind === 'variables') return /^[a-zA-Z0-9]+$/.test(name);
  return (
    /^[A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*$/.test(name) &&
    Object.hasOwn(extractBlocks(`title ${name} (\nbody\n)`, 'title'), name)
  );
}

const sourceSchema = z
  .object({
    repository: z.string().min(1),
    revision: globalRevisionSchema,
    path: z.string().min(1),
    /** JSON keys selecting the original decoded string; spans index its UTF-16 code units. */
    selector: z.array(z.string()).min(1),
    spanConvention: z.literal('decoded-utf16'),
    hash: z.union([z.literal(2), z.literal(3)]),
    lang: langSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.to > v.from, 'Source span must be nonempty');

export const globalDefinitionSchema = z
  .object({
    /** Body only; an empty variable is serialized as the legacy `empty` value. */
    body: z.string(),
    revision: globalRevisionSchema,
    updatedAt: timestampSchema,
    updatedBy: z.string(),
    sourceUpdatedAt: timestampSchema.optional(),
    sourceRevision: globalRevisionSchema.optional(),
    provenance: sourceSchema,
  })
  .strict();

export const globalRecordSchema = z
  .object({
    version: z.literal(1),
    id: globalIdSchema,
    kind: globalKindSchema,
    name: z.string().min(1),
    revision: globalRevisionSchema,
    definitions: z.partialRecord(langSchema, globalDefinitionSchema),
    nameHistory: z.array(
      z
        .object({
          name: z.string().min(1),
          revision: globalRevisionSchema,
          at: timestampSchema,
          by: z.string().min(1),
        })
        .strict(),
    ),
    tombstone: z
      .object({ at: timestampSchema, by: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (!validGlobalName(record.kind, record.name))
      ctx.addIssue({ code: 'custom', message: 'Name cannot round-trip through the resolver' });
    for (const [lang, definition] of Object.entries(record.definitions)) {
      if (
        definition.provenance.lang !== lang ||
        definition.provenance.hash !== (record.kind === 'variables' ? 2 : 3)
      )
        ctx.addIssue({ code: 'custom', message: 'Definition provenance kind/language mismatch' });
      if (record.kind === 'variables' && /[\r\n]/.test(definition.body))
        ctx.addIssue({ code: 'custom', message: 'Variables must fit on one line' });
      if (record.kind === 'titles' && !definition.body.trim())
        ctx.addIssue({ code: 'custom', message: 'Title bodies must not be empty' });
    }
  });

/** Ordered projection recipe, with comments and separators retained as literal bytes. */
export const globalSegmentSchema = z.union([
  z.object({ literal: z.string() }).strict(),
  z
    .object({
      entryId: globalIdSchema,
      beforeName: z.string(),
      afterName: z.string(),
      afterBody: z.string(),
    })
    .strict(),
]);
export const globalAggregateSchema = z
  .object({
    document: z.object(tooltipSchema.shape).omit({ text: true }).strict(),
    languages: z.partialRecord(
      langSchema,
      z
        .object({
          metadata: langTextSchema.omit({ text: true }),
          segments: z.array(globalSegmentSchema),
        })
        .strict(),
    ),
  })
  .strict();
export const globalStoreSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(globalRecordSchema),
    aggregates: z.array(globalAggregateSchema),
  })
  .strict()
  .superRefine((store, ctx) => {
    const ids = new Set<string>(),
      names = new Set<string>(),
      hashes = new Set<number>();
    for (const entry of store.entries) {
      if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate global ID' });
      ids.add(entry.id);
      const key = `${entry.kind}:${entry.name}`;
      if (!entry.tombstone && names.has(key))
        ctx.addIssue({ code: 'custom', message: 'Duplicate global name across languages' });
      if (!entry.tombstone) names.add(key);
    }
    for (const aggregate of store.aggregates) {
      const hash = aggregate.document.hash;
      if ((hash !== 2 && hash !== 3) || hashes.has(hash))
        ctx.addIssue({ code: 'custom', message: 'Expected unique aggregate hashes 2 and 3' });
      hashes.add(hash);
      for (const [lang, layout] of Object.entries(aggregate.languages)) {
        const seen = new Set<string>();
        for (const segment of layout.segments) {
          if (!('entryId' in segment)) continue;
          const entry = store.entries.find((v) => v.id === segment.entryId);
          if (
            !entry ||
            entry.tombstone ||
            entry.kind !== (hash === 2 ? 'variables' : 'titles') ||
            !entry.definitions[lang as keyof typeof entry.definitions] ||
            seen.has(segment.entryId)
          )
            ctx.addIssue({ code: 'custom', message: 'Invalid or duplicate projection entry' });
          seen.add(segment.entryId);
        }
        for (const entry of store.entries) {
          if (
            !entry.tombstone &&
            entry.kind === (hash === 2 ? 'variables' : 'titles') &&
            entry.definitions[lang as keyof typeof entry.definitions] &&
            !seen.has(entry.id)
          )
            ctx.addIssue({ code: 'custom', message: 'Definition missing from projection' });
        }
      }
    }
    for (const entry of store.entries) {
      if (entry.tombstone) continue;
      for (const lang of Object.keys(entry.definitions))
        if (
          !store.aggregates.some(
            (a) =>
              a.document.hash === (entry.kind === 'variables' ? 2 : 3) &&
              Object.hasOwn(a.languages, lang),
          )
        )
          ctx.addIssue({ code: 'custom', message: 'Missing language projection' });
    }
  });

export const globalConsumerSchema = z
  .object({
    hash: hashSchema,
    lang: langSchema,
    destination: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  })
  .strict();
export const globalCauseSchema = z
  .object({
    globalId: globalIdSchema,
    beforeRevision: globalRevisionSchema.nullable(),
    afterRevision: globalRevisionSchema.nullable(),
  })
  .strict();
export const globalReviewSchema = z
  .object({
    version: z.literal(1),
    consumer: globalConsumerSchema,
    causes: z.array(globalCauseSchema).min(1),
    contentDigest: globalDigestSchema,
    dependencyDigest: globalDigestSchema,
    acknowledgement: z
      .object({
        by: z.string().min(1),
        at: timestampSchema,
        contentDigest: globalDigestSchema,
        dependencyDigest: globalDigestSchema,
        /** Binds the before/after rendered review, including its complete cause set. */
        impactDigest: globalDigestSchema,
        decision: z.enum(['edited', 'no-text-change']),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GlobalRecord = z.infer<typeof globalRecordSchema>;
export type GlobalDefinition = z.infer<typeof globalDefinitionSchema>;
export type GlobalStore = z.infer<typeof globalStoreSchema>;
export type GlobalSegment = z.infer<typeof globalSegmentSchema>;
export type GlobalConsumer = z.infer<typeof globalConsumerSchema>;
export type GlobalCause = z.infer<typeof globalCauseSchema>;
export type GlobalReview = z.infer<typeof globalReviewSchema>;
