import { z } from 'zod';
import { langSchema } from './languages.js';
import { timestampSchema } from './schemas.js';

/** Save request evidence for a revision change with byte-identical translation text. */
export const translationRevisionsSchema = z.partialRecord(
  langSchema.exclude(['en']),
  z
    .object({
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      sourceUpdatedAt: timestampSchema,
      restore: z.literal(true).optional(),
    })
    .strict(),
);

export type TranslationRevisions = z.infer<typeof translationRevisionsSchema>;
