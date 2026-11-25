import {
  globalIdSchema,
  hashSchema,
  translationLanguageSchema,
  translationPublishContract,
  type TranslationLanguage,
  type TranslationPublishRow,
} from '@clarity/core';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const tooltip = { kind: z.literal('tooltip'), hash: hashSchema };
const global = { kind: z.literal('global'), id: globalIdSchema };
const ready = {
  status: z.literal('ready'),
  lang: translationLanguageSchema,
  expected: digest,
  english: digest,
  before: digest,
  effects: digest,
  removed: z.boolean(),
  englishFallback: z.boolean(),
  /** Other tooltips whose published text changes with this row. */
  affectedHashes: z.array(hashSchema),
  snapshot: z.string().optional(),
};
const blocked = {
  status: z.enum(['waiting', 'refused']),
  lang: translationLanguageSchema,
  reason: z.string().min(1),
  snapshot: z.string().optional(),
};
const rowSchema = z.union([
  z.object({ ...ready, ...tooltip }),
  z.object({ ...ready, ...global, affected: digest }),
  z.object({ ...blocked, ...tooltip }),
  z.object({ ...blocked, ...global }),
]);
export type PendingTranslation = z.infer<typeof rowSchema>;
export type ReadyTranslation = Extract<PendingTranslation, { status: 'ready' }>;

/** One row per tooltip or shared text and language, as the publisher prepared it for this bundle. */
export const translationPublishSchema = z.object({
  version: z.literal(translationPublishContract),
  liveCommit: z.string(),
  lanes: z
    .partialRecord(translationLanguageSchema, z.array(rowSchema))
    .refine(
      (lanes) =>
        Object.entries(lanes).every(([lang, rows]) => rows!.every((row) => row.lang === lang)),
      'A row belongs to its own language',
    ),
  /** Rows of the ordinary list where nothing but translations waits. */
  only: z
    .object({ tooltips: z.array(hashSchema), globals: z.array(globalIdSchema) })
    .optional()
    .catch(undefined),
});

type Identity = { lang: TranslationLanguage } & (
  { kind: 'tooltip'; hash: number } | { kind: 'global'; id: string }
);
/** A row's identity: its tooltip or shared text, and the language. */
export const translationKey = (row: Identity) =>
  `${row.kind === 'tooltip' ? row.hash : row.id}:${row.lang}`;

/** Exactly the signed facts; nothing else of the bundle row is sent. */
export function translationRequestRow(row: ReadyTranslation): TranslationPublishRow {
  const { lang, expected, english, before, effects } = row;
  const lane = { lang, expected, english, before, effects };
  return row.kind === 'tooltip'
    ? { kind: row.kind, hash: row.hash, ...lane }
    : { kind: row.kind, id: row.id, affected: row.affected, ...lane };
}
