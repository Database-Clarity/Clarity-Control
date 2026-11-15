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

export const worklistOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), ...storedWorklistSchema.shape }).strict(),
  z.object({ type: z.literal('rename'), name: worklistNameSchema }).strict(),
  z.object({ type: z.literal('delete') }).strict(),
  z.object({ type: z.literal('add'), hashes: worklistHashesSchema }).strict(),
  z.object({ type: z.literal('remove'), hashes: worklistHashesSchema }).strict(),
  z
    .object({
      type: z.literal('move'),
      hash: z.number().int().nonnegative().max(0xffffffff),
      index: z.number().int().nonnegative().max(499),
    })
    .strict(),
]);
export type WorklistOperation = z.infer<typeof worklistOperationSchema>;
export type StoredWorklist = z.infer<typeof storedWorklistSchema>;
/** Idempotent operations applied to the authoritative row, never a merged snapshot. */
export function applyWorklistOperation(
  row: StoredWorklist | null,
  op: WorklistOperation,
): StoredWorklist | null {
  if (op.type === 'delete') return null;
  if (op.type === 'create') return row ?? { name: op.name, hashes: [...op.hashes] };
  if (!row) return null;
  if (op.type === 'rename') return { ...row, name: op.name };
  let hashes = [...row.hashes];
  if (op.type === 'add') hashes = [...new Set([...hashes, ...op.hashes])];
  if (op.type === 'remove') {
    const removed = new Set(op.hashes);
    hashes = hashes.filter((hash) => !removed.has(hash));
  }
  if (op.type === 'move') {
    const at = hashes.indexOf(op.hash);
    if (at >= 0) {
      hashes.splice(at, 1);
      hashes.splice(Math.min(op.index, hashes.length), 0, op.hash);
    }
  }
  return { ...row, hashes };
}
