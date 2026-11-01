import { z } from 'zod';

export const guidanceCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  rule: z.string(),
  count: z.number().int().nonnegative(),
  hashes: z.array(z.number().int().nonnegative()),
  active: z.boolean(),
  comment: z.string().max(100_000),
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
          new Set(category.hashes).size === category.hashes.length,
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
