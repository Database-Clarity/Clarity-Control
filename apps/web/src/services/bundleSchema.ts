import {
  permissionsSchema,
  pushedSchema,
  sandboxPointersSchema,
  inactiveMovesSchema,
  tooltipSchema,
  aliasGroupsSchema,
  globalIdSchema,
  globalRecordSchema,
  langSchema,
} from '@clarity/core';
import { z } from 'zod';

const globalUseSchema = z.object({
  langs: z.array(langSchema),
  direct: z.boolean(),
  via: z.array(z.string()),
});
const globalUsagesSchema = z.object({
  tooltips: z.array(
    globalUseSchema.extend({
      hash: z.uint32(),
      open: z.object({
        variant: z.uint32(),
        lang: langSchema,
        line: z.int().positive().optional(),
      }),
      members: z.int().positive(),
    }),
  ),
  globals: z.array(globalUseSchema.extend({ id: globalIdSchema })),
});

export const bundleSchema = z.object({
  sourceCommit: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  tooltips: z
    .record(z.string(), tooltipSchema)
    .refine(
      (tooltips) => Object.entries(tooltips).every(([key, value]) => key === String(value.hash)),
      'Tooltip keys must match their hashes',
    ),
  permissions: permissionsSchema,
  pushed: pushedSchema,
  /** Accepted groups and archived tooltip removals belong to the same sourceCommit. */
  aliasGroups: aliasGroupsSchema.optional(),
  /** Maintainer moves fail closed: a malformed file must not silently restore exports. */
  inactiveMoves: inactiveMovesSchema.optional(),
  /** Maintainer picks for shared sandbox perks (config/sandbox-pointers.json); absent while none. */
  sandboxPointers: sandboxPointersSchema
    .optional()
    // A malformed file must not make the bundle unloadable; the Worker fails closed on it anyway.
    .catch(undefined),
  /**
   * The globals catalogue at sourceCommit (publisher bundleGlobals): every entry in catalogue
   * order and the public sync header. Null or absent (malformed, or an older publisher) means
   * unavailable; it never makes the tooltips unloadable.
   */
  globals: z
    .object({
      entries: z.array(globalRecordSchema),
      sync: z.object({
        status: z.enum(['sync-pending', 'sync-failed', 'current']),
        causeIds: z.array(z.string().max(128)).max(32),
        lastFailure: z.string().max(512).nullable(),
        causeEntries: z.record(z.string().max(128), globalIdSchema),
      }),
      /** Missing on older bundles. A present row can explicitly contain no uses. */
      usages: z.record(globalIdSchema, globalUsagesSchema).optional().catch(undefined),
    })
    .transform((catalog) =>
      catalog.usages &&
      catalog.entries.some(({ id, tombstone }) => !tombstone && !catalog.usages?.[id])
        ? { ...catalog, usages: undefined }
        : catalog,
    )
    .nullable()
    .optional()
    .catch(null),
  /** Publish requests waiting in the Worker's queue (written by the publisher pipeline; absent until it runs). */
  publishQueue: z
    .array(
      z.union([
        z.object({
          opId: z.string(),
          requester: z.object({ id: z.number(), login: z.string() }),
          hashes: z.array(z.number()),
          createdAt: z.string(),
        }),
        z.object({ opId: z.string(), invalid: z.literal(true) }),
      ]),
    )
    .optional()
    // Informational only: a malformed queue must never make the whole bundle unloadable.
    .catch(undefined),
});
export type Bundle = z.infer<typeof bundleSchema>;
