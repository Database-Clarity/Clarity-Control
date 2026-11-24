import { z } from 'zod';
import { langSchema } from '../languages.js';
import { globalIdSchema } from './model.js';

/** Immutable DATA commit supplying the saved definitions the reviewer saw. */
export const globalsRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);

const cell = z.object({
  main: z.string(),
  secondary: z.string(),
  englishFallback: z.literal(true).optional(),
});

/** Sparse effective changes against LIVE. Authored pending rows still use the usual markers. */
export const globalsInPlaceReviewSchema = z.object({
  revision: globalsRevisionSchema,
  rows: z.record(
    z.string().regex(/^(0|[1-9]\d*)$/),
    z.object({
      differs: z.boolean(),
      causes: z.array(z.object({ id: globalIdSchema, name: z.string() })),
      diff: z.partialRecord(langSchema, z.object({ before: cell.nullable(), after: cell.nullable() })),
      refusal: z.string().optional(),
    }),
  ),
});

export type GlobalsInPlaceReview = z.infer<typeof globalsInPlaceReviewSchema>;
