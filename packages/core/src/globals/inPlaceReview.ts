import { z } from 'zod';
import { langSchema } from '../languages.js';
import { globalIdSchema } from './model.js';

/** Immutable DATA commit supplying the saved definitions the reviewer saw. */
export const globalsRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** Absent before migration. Both states prohibit the old publication path. */
export const globalsInPlacePath = 'config/globals-in-place.json';
export const globalsInPlaceCapability = 'globalsInPlaceV1';
export const globalsInPlaceFenceSchema = z
  .object({
    state: z.enum(['hold', 'active']),
    clearance: z.literal('review'),
    destination: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    legacyData: globalsRevisionSchema,
    legacyLive: globalsRevisionSchema,
    migratedLive: globalsRevisionSchema,
  })
  .strict();
export type GlobalsInPlaceFence = z.infer<typeof globalsInPlaceFenceSchema>;

export function globalsInPlaceClearance(fence: GlobalsInPlaceFence): boolean {
  return fence.state === 'active' && fence.clearance === 'review';
}

const cell = z.object({
  main: z.string(),
  secondary: z.string(),
  englishFallback: z.literal(true).optional(),
});

/** Effective changes and shared fallback notices. Authored pending still uses the usual markers. */
export const globalsInPlaceReviewSchema = z.object({
  revision: globalsRevisionSchema,
  rows: z.record(
    z.string().regex(/^(0|[1-9]\d*)$/),
    z.object({
      differs: z.boolean(),
      causes: z.array(
        z.object({
          id: globalIdSchema,
          name: z.string(),
          fallbacks: z.partialRecord(langSchema, z.enum(['missing', 'stale'])).optional(),
        }),
      ),
      diff: z.partialRecord(
        langSchema,
        z.object({ before: cell.nullable(), after: cell.nullable() }),
      ),
      refusal: z.string().optional(),
    }),
  ),
});

export type GlobalsInPlaceReview = z.infer<typeof globalsInPlaceReviewSchema>;
