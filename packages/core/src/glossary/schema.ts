import { z } from 'zod';
import { langSchema, type Lang } from '../languages.js';

export const glossaryKey = (en: string) =>
  en.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const maxGlossaryTerms = 1000;
export const maxGlossaryBytes = 256 * 1024;
export const glossaryLangSchema = langSchema.refine(
  (lang) => lang !== 'en',
  'English has no glossary',
);
const text = (max: number) => z.string().trim().min(1).max(max);
export const glossaryValueSchema = z
  .object({
    en: text(60),
    also: z.array(text(60)).max(8).optional(),
    term: text(80),
    forms: z.array(text(60)).max(8).optional(),
    note: z.string().max(240).optional(),
    matchCase: z.literal(true).optional(),
  })
  .strict();
export const glossaryEntrySchema = glossaryValueSchema
  .extend({
    updatedAt: z.iso.datetime(),
    updatedBy: text(100),
  })
  .strict();
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;
export const glossarySchema = z
  .object({
    v: z.literal(1),
    lang: glossaryLangSchema,
    terms: z.record(z.string().min(1).max(180), glossaryEntrySchema),
  })
  .strict()
  .superRefine(({ terms }, ctx) => {
    if (Object.keys(terms).length > maxGlossaryTerms)
      ctx.addIssue({ code: 'custom', message: `At most ${maxGlossaryTerms} terms` });
    for (const [key, entry] of Object.entries(terms)) {
      if (key !== glossaryKey(entry.en) || ['__proto__', 'constructor', 'prototype'].includes(key))
        ctx.addIssue({ code: 'custom', message: 'Invalid glossary key', path: ['terms', key] });
    }
  });
export type Glossary = z.infer<typeof glossarySchema>;
// next accepts stamps for compatibility with the shared optimistic apply; the server replaces them.
export const glossaryOpSchema = z
  .object({
    key: z.string().min(1).max(180),
    base: glossaryEntrySchema.nullable(),
    next: glossaryValueSchema
      .extend({
        updatedAt: z.string().optional(),
        updatedBy: z.string().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((op, ctx) => {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(op.key) ||
      [op.base, op.next].some((entry) => entry && glossaryKey(entry.en) !== op.key)
    )
      ctx.addIssue({ code: 'custom', message: 'Key must match the English term' });
  });
export const glossaryInputSchema = z
  .object({ ops: z.array(glossaryOpSchema).min(1).max(20) })
  .strict()
  .refine(({ ops }) => new Set(ops.map((op) => op.key)).size === ops.length, 'Duplicate keys');
export type GlossaryOp = z.infer<typeof glossaryOpSchema>;
export const emptyGlossary = (lang: Lang): Glossary => ({
  v: 1,
  lang: glossaryLangSchema.parse(lang),
  terms: {},
});
