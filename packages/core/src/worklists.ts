import { z } from 'zod';

export const worklistIdSchema = z.string().uuid();
export const worklistNameSchema = z.string().trim().min(1).max(80);
export const worklistHashesSchema = z
  .array(z.number().int().nonnegative().max(0xffffffff))
  .max(500)
  .refine((hashes) => new Set(hashes).size === hashes.length, 'Entries must be unique')
  .refine((hashes) => JSON.stringify(hashes).length <= 16_384, 'Worklist entries exceed 16 KB');
export const storedWorklistSchema = z
  .object({ name: worklistNameSchema, hashes: worklistHashesSchema })
  .strict();
export const worklistIndexEntrySchema = z.object({
  id: worklistIdSchema,
  name: worklistNameSchema,
  count: z.number().int().nonnegative().max(500),
  updatedAt: z.number().int().nonnegative(),
  revision: z.string(),
});
export type WorklistIndexEntry = z.infer<typeof worklistIndexEntrySchema>;

export const worklistItemSchema = z
  .object({
    hash: z.number().int().nonnegative().max(0xffffffff),
    name: z.string().max(160),
  })
  .strict();
export const worklistSchema = z
  .object({
    id: worklistIdSchema,
    name: worklistNameSchema,
    items: z
      .array(worklistItemSchema)
      .refine(
        (items) => worklistHashesSchema.safeParse(items.map((item) => item.hash)).success,
        'Worklist entries exceed 16 KB or 500 entries',
      ),
  })
  .strict()
  .refine(
    (list) => new Set(list.items.map((item) => item.hash)).size === list.items.length,
    'An entry can only appear once in a worklist',
  );
export const recoveredWorklistsSchema = z.array(
  z.object({ ...worklistSchema.shape, items: z.array(worklistItemSchema) }),
);
export const worklistsSchema = z
  .array(worklistSchema)
  .max(50)
  .refine(
    (lists) => new Set(lists.map((list) => list.id)).size === lists.length,
    'Worklist ids must be unique',
  );
export type SavedWorklist = z.infer<typeof worklistSchema>;
export type WorklistEntry = z.infer<typeof worklistItemSchema>;
export const worklistsBodyLimit = 20_000;

/** Conflict recovery preserves every list and item, in the order already on this device.
 * Deletions that race additions can reappear; the UI explains this rather than losing work.
 */
export function mergeWorklists(local: SavedWorklist[], remote: SavedWorklist[]): SavedWorklist[] {
  const result = local.map((list) => ({ ...list, items: [...list.items] }));
  const byId = new Map(result.map((list) => [list.id, list]));
  for (const list of remote) {
    const found = byId.get(list.id);
    if (!found) {
      const copy = { ...list, items: [...list.items] };
      result.push(copy);
      byId.set(copy.id, copy);
    } else {
      const hashes = new Set(found.items.map((item) => item.hash));
      for (const item of list.items)
        if (!hashes.has(item.hash)) {
          found.items.push(item);
          hashes.add(item.hash);
        }
    }
  }
  return result;
}
