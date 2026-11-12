import { permissionsSchema, pushedSchema, sandboxPointersSchema, tooltipSchema } from '@clarity/core';
import { z } from 'zod';

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
  /** Maintainer picks for shared sandbox perks (config/sandbox-pointers.json); absent while none. */
  sandboxPointers: sandboxPointersSchema
    .optional()
    // A malformed file must not make the bundle unloadable; the Worker fails closed on it anyway.
    .catch(undefined),
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
