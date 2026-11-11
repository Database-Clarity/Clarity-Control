import { z } from 'zod';
import { hashSchema, legacyMetadataSchema } from './legacy.js';
import { langSchema } from './languages.js';
import { compendiumLinkSchema } from './compendium/types.js';

export const timestampSchema = z.string().datetime({ offset: true });
export const langTextSchema = z
  .object({
    text: z.string(),
    updatedAt: timestampSchema,
    updatedBy: z.string(),
    sourceUpdatedAt: timestampSchema.optional(),
  })
  .strict();
export const tooltipSchema = z
  .object({
    hash: hashSchema,
    custom: z.object({ name: z.string(), categoryId: z.string() }).strict().optional(),
    text: z.partialRecord(langSchema, langTextSchema),
    associated: z
      .array(hashSchema)
      .refine((values) => new Set(values).size === values.length, 'Associations must be unique'),
    compendium: compendiumLinkSchema.optional(),
    bungieSnapshot: z
      .object({
        description: z.string(),
        snapshotAt: timestampSchema,
      })
      .strict()
      .optional(),
    archive: z
      .object({
        removedAt: timestampSchema,
        lastSeen: z
          .object({
            name: z.string(),
            categoryId: z.string(),
            icon: z.string().optional(),
            manifestVersion: z.string(),
          })
          .strict(),
        successor: hashSchema.optional(),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
    legacy: legacyMetadataSchema.optional(),
  })
  .strict();
export const permissionsSchema = z
  .object({
    users: z.record(
      z.string().regex(/^[1-9]\d*$/),
      z
        .object({
          login: z.string().min(1),
          role: z.enum(['maintainer', 'editor', 'trial', 'translator']),
          languages: z.array(langSchema).optional(),
        })
        .strict(),
    ),
    /**
     * Export partners (spec section 4): numeric GitHub id -> the export projects that account may
     * edit. Optional and additive, so files without it parse as before. A user listed only here
     * has the `partner` role: read-only, published data only, and nothing in `users` grants it.
     */
    partners: z
      .record(
        z.string().regex(/^[1-9]\d*$/),
        z
          .object({
            login: z.string().min(1).max(39),
            projects: z
              .array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/))
              .min(1)
              .max(40)
              .refine((list) => new Set(list).size === list.length, 'Duplicate project'),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const pushedSchema = z.record(
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .refine((value) => Number(value) <= 0xffffffff),
  z.string().regex(/^[0-9a-f]{64}$/),
);
export type LangText = z.infer<typeof langTextSchema>;
export type Tooltip = z.infer<typeof tooltipSchema>;
/** Metadata-only records stay in editor-data, never in consumer inputs or push queues. */
export function hasTooltipText(tooltip: Tooltip): boolean {
  return Object.values(tooltip.text).some((entry) => entry?.text.trim());
}
export type Permissions = z.infer<typeof permissionsSchema>;
export type Pushed = z.infer<typeof pushedSchema>;
