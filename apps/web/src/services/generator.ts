import { z } from 'zod';
import { aliasesSchema, hashSchema } from '@clarity/core';
import { fetchJson } from './http';

const source =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2';

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
  itemHash: hashSchema.optional(),
  enhancedHash: hashSchema.optional(),
  enhancedHashes: z.array(hashSchema).optional(),
  baseHash: hashSchema.optional(),
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

export async function loadGenerator(signal?: AbortSignal) {
  const [categories, items, aliases] = await Promise.all([
    fetchJson(`${source}/categories.json`, z.array(categorySchema), { signal }),
    fetchJson(`${source}/items.json`, itemsSchema, { signal }),
    fetchJson(`${source}/aliases.json`, aliasesSchema, { signal }),
  ]);
  return {
    categories,
    items,
    aliases,
  };
}
