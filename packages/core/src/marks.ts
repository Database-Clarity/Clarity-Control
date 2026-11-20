import { z } from 'zod';
import { hashSchema } from './legacy.js';
import { inactiveHashKey } from './inactiveMoves.js';

export const marksPath = 'config/marks.json';
export const maxMarksBytes = 700_000;
export const maxMarkedEntries = 1500;
export const maxEntryMarks = 1500;
export const maxMarkNoteChars = 2000;
export const markColours = ['neutral', 'blue', 'green', 'amber', 'red', 'purple'] as const;
export const markIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const stamp = { by: z.number().int().positive(), at: z.string().datetime({ offset: true }) };
export const markTypeSchema = z
  .object({
    id: markIdSchema,
    label: z.string().trim().min(1).max(64),
    colour: z.enum(markColours),
    ...stamp,
  })
  .strict();
export const entryMarkSchema = z
  .object({
    type: markIdSchema,
    note: z.string().trim().max(maxMarkNoteChars).optional(),
    ...stamp,
  })
  .strict();
export const marksSchema = z
  .object({
    types: z.array(markTypeSchema).max(32),
    entries: z
      .record(inactiveHashKey, z.array(entryMarkSchema).min(1).max(32))
      .refine(
        (entries) => Object.keys(entries).length <= maxMarkedEntries,
        'Too many marked entries',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.types.map((type) => type.id));
    if (ids.size !== value.types.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate mark type IDs' });
    const labels = new Set(value.types.map((type) => type.label.toLowerCase()));
    if (labels.size !== value.types.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate mark type labels' });
    let count = 0;
    for (const marks of Object.values(value.entries)) {
      count += marks.length;
      if (new Set(marks.map((mark) => mark.type)).size !== marks.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate entry marks' });
      if (marks.some((mark) => !ids.has(mark.type)))
        ctx.addIssue({ code: 'custom', message: 'Unknown mark type' });
    }
    if (count > maxEntryMarks)
      ctx.addIssue({ code: 'custom', message: `Too many entry marks (maximum ${maxEntryMarks})` });
  });
/**
 * The structural checks alone: a writer validates the stored file once, then checks the byte cap
 * on the single string it commits. Readers use `marksFileSchema`, which adds the byte cap.
 */
export const marksStructureSchema = marksSchema;
export const marksFileSchema = marksSchema.superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n').length > maxMarksBytes)
    ctx.addIssue({ code: 'custom', message: `Marks file exceeds ${maxMarksBytes} bytes` });
});
export type Marks = z.infer<typeof marksSchema>;
export type MarkType = z.infer<typeof markTypeSchema>;
export type EntryMark = z.infer<typeof entryMarkSchema>;
export const emptyMarks = (): Marks => ({ types: [], entries: {} });
export const markActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('mark'),
      hash: hashSchema,
      type: markIdSchema,
      note: z.string().trim().max(maxMarkNoteChars).optional(),
    })
    .strict(),
  z.object({ action: z.literal('unmark'), hash: hashSchema, type: markIdSchema }).strict(),
  z
    .object({
      action: z.literal('create-type'),
      id: markIdSchema,
      label: markTypeSchema.shape.label,
      colour: markTypeSchema.shape.colour,
    })
    .strict(),
  z
    .object({
      action: z.literal('edit-type'),
      id: markIdSchema,
      label: markTypeSchema.shape.label,
      colour: markTypeSchema.shape.colour,
    })
    .strict(),
  z
    .object({ action: z.literal('remove-type'), id: markIdSchema, force: z.boolean().optional() })
    .strict(),
]);
export type MarkAction = z.infer<typeof markActionSchema>;
export const marksRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .nullable();
export const updateMarksSchema = z
  .object({
    revision: marksRevisionSchema,
    change: markActionSchema,
  })
  .strict();
