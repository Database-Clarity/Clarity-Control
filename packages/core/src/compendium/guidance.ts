import { z } from 'zod';
import { compendiumLinkSchema } from './types.js';

export const guidanceReferenceSchema = z
  .object({
    hash: z.number().int().nonnegative(),
    name: z.string(),
    categoryId: z.string().min(1),
    evidence: z.string(),
    baseline: z.string(),
    timestamp: z.string().datetime({ offset: true }),
    note: z.string().max(10_000),
    decision: z.enum(['accepted', 'picked', 'no-equivalent', 'skipped']).optional(),
    link: compendiumLinkSchema.optional(),
    sourceHash: z.string().optional(),
    sourceName: z.string().optional(),
    sourceTab: z.string().optional(),
    sourceRow: z.number().int().positive().optional(),
  })
  .refine(
    (reference) =>
      reference.decision === 'accepted' || reference.decision === 'picked'
        ? !!reference.link &&
          !!reference.sourceHash &&
          !!reference.sourceName &&
          !!reference.sourceTab &&
          !!reference.sourceRow
        : !reference.link,
    'Link decisions require confirmed source evidence; other decisions must not contain a link',
  );
export type GuidanceReference = z.infer<typeof guidanceReferenceSchema>;

export const guidanceCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  rule: z.string(),
  count: z.number().int().nonnegative(),
  hashes: z.array(z.number().int().nonnegative()),
  active: z.boolean(),
  comment: z.string().max(100_000),
  references: z.record(z.string(), guidanceReferenceSchema).optional(),
});
export type GuidanceCategory = z.infer<typeof guidanceCategorySchema>;
export const guidanceSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    baseline: z.string(),
    categories: z.record(z.string(), guidanceCategorySchema),
  })
  .refine(
    (document) =>
      Object.entries(document.categories).every(
        ([id, category]) =>
          id === category.id &&
          category.count === category.hashes.length &&
          new Set(category.hashes).size === category.hashes.length &&
          Object.entries(category.references ?? {}).every(
            ([hash, reference]) => hash === String(reference.hash) && reference.categoryId === id,
          ),
      ),
    'Guidance category keys, counts and unique hashes must agree',
  )
  .refine((document) => {
    const hashes = Object.values(document.categories)
      .filter((category) => category.active)
      .flatMap((category) => category.hashes);
    return new Set(hashes).size === hashes.length;
  }, 'Active guidance categories must not overlap');
export type GuidanceDocument = z.infer<typeof guidanceSchema>;
export const guidanceResponseSchema = z.object({
  document: guidanceSchema.nullable(),
  revision: z.string().nullable(),
});
export const guidanceWriteSchema = z.object({
  document: guidanceSchema,
  revision: z.string().nullable(),
});
export const guidanceCacheSchema = z.object({
  document: guidanceSchema,
  revision: z.string().nullable(),
  pending: z.boolean(),
});
