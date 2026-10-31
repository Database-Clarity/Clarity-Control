import { z } from 'zod';
import {
  aliasesSchema,
  completeWeaponTypeLabels,
  hashSchema,
  weaponTypeLabelsSchema,
} from '@clarity/core';
import { fetchJson, fetchOptionalJson } from './http';

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
  /** Weapon types the item appears on (optional generator fact). */
  weaponTypes: z.array(z.string()).optional(),
  /** All owning exotic items; present only for perks shared by two or more exotics. */
  owners: z.array(hashSchema).optional(),
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
  const [categories, items, aliases, weaponTypeLabels] = await Promise.all([
    fetchJson(`${source}/categories.json`, z.array(categorySchema), { signal }),
    fetchJson(`${source}/items.json`, itemsSchema, { signal }),
    fetchJson(`${source}/aliases.json`, aliasesSchema, { signal }),
    // Optional: absent until the generator emits it; English defaults then apply.
    fetchOptionalJson(`${source}/weaponTypes.json`, weaponTypeLabelsSchema, { signal }),
  ]);
  return {
    categories,
    items,
    aliases,
    weaponTypeLabels: completeWeaponTypeLabels(weaponTypeLabels),
  };
}
