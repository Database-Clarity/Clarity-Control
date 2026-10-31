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
export type Permissions = z.infer<typeof permissionsSchema>;
export type Pushed = z.infer<typeof pushedSchema>;
