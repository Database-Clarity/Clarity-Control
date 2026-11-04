import { z } from 'zod';
import { hashSchema } from '@clarity/core';

export const categorySchema = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string(),
  order: z.number(),
  legacyType: z.string().optional(),
});
export const itemSchema = z.object({
  hash: hashSchema,
  name: z.string(),
  icon: z.string(),
  categoryId: z.string(),
  inGameDescription: z.string(),
  definitionType: z.string().optional(),
  setHash: hashSchema.optional(),
  setName: z.string().optional(),
  pieceCount: z.union([z.literal(2), z.literal(4)]).optional(),
  hiddenFromEditor: z.boolean().optional(),
  itemHash: hashSchema.optional(),
  itemName: z.string().optional(),
  enhancedHash: hashSchema.optional(),
  enhancedHashes: z.array(hashSchema).optional(),
  baseHash: hashSchema.optional(),
  dimBaseHash: hashSchema.optional(),
  plugCategoryHash: hashSchema.optional(),
  sandboxPerkHashes: z.array(hashSchema).optional(),
  /** All owning exotic items; present only for perks shared by two or more exotics. */
  owners: z.array(hashSchema).optional(),
  ownerNames: z.record(z.string(), z.string()).optional(),
});
export const itemsSchema = z
  .record(z.string(), itemSchema)
  .refine(
    (items) => Object.entries(items).every(([key, item]) => key === String(item.hash)),
    'Item keys must match their hashes',
  );
export type Category = z.infer<typeof categorySchema>;
export type Item = z.infer<typeof itemSchema>;
