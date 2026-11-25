import { z } from 'zod';
import type { Aliases } from './aliases.js';
import { stableStringify } from './contentHash.js';
import { globalIdSchema } from './globals/model.js';
import { langSchema } from './languages.js';
import { hashSchema } from './legacy.js';
import {
  parsePublishRequestPayload,
  publishOpIdSchema,
  publishPayloadSchema,
  publishRequestIntentDigest,
  type PublishRequestPayload,
} from './publishRequest.js';

export const translationPublishCapability = 'translationPublishV1';
export const translationPublishContract = 'translation-publish-v1';
export const translationLanguageSchema = langSchema.exclude(['en']);
export type TranslationLanguage = z.infer<typeof translationLanguageSchema>;

const { kind, repo, dataBranch, liveBranch, requester, createdAt, intentDigest } =
  publishPayloadSchema.shape;
const lane = {
  lang: translationLanguageSchema,
  expected: intentDigest,
  english: intentDigest,
  before: intentDigest,
  effects: intentDigest,
};
const rowSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...lane,
      kind: z.literal('tooltip'),
      hash: hashSchema.refine((hash) => hash < 1 || hash > 3, 'Library hashes are reserved'),
    })
    .strict(),
  z
    .object({
      ...lane,
      kind: z.literal('global'),
      id: globalIdSchema,
      affected: intentDigest,
    })
    .strict(),
]);
export type TranslationPublishRow = z.infer<typeof rowSchema>;
const rowKey = (row: TranslationPublishRow) =>
  `${row.kind}/${row.kind === 'tooltip' ? row.hash : row.id}/${row.lang}`;

// Use one shape at the HTTP and signed boundaries. Root/alias identity is checked against the
// authoritative alias map by the parsers; a JSON schema cannot tell if a hash names an alias.
export const translationPublishBodySchema = z
  .object({
    opId: publishOpIdSchema,
    scope: z.literal('translations'),
    rows: z
      .array(rowSchema)
      .min(1)
      .refine(
        (rows) => new Set(rows.map(rowKey)).size === rows.length,
        'Duplicate translation row',
      ),
  })
  .strict();
export const translationPublishPayloadSchema = translationPublishBodySchema.extend({
  kind,
  repo,
  dataBranch,
  liveBranch,
  requester,
  createdAt,
  intentDigest,
});

export type TranslationPublishBody = z.infer<typeof translationPublishBodySchema>;
export type TranslationPublishPayload = z.infer<typeof translationPublishPayloadSchema>;
export type TranslationPublishIntent = Omit<
  TranslationPublishPayload,
  'createdAt' | 'intentDigest'
>;
export type ScopedPublishRequestPayload = PublishRequestPayload | TranslationPublishPayload;

export function parseTranslationPublishBody(
  value: unknown,
  aliases: Aliases,
): TranslationPublishBody {
  const body = translationPublishBodySchema.parse(value);
  assertTranslationRoots(body.rows, aliases);
  return body;
}

export function assertTranslationRoots(
  rows: readonly TranslationPublishRow[],
  aliases: Aliases,
): void {
  for (const row of rows)
    if (row.kind === 'tooltip' && Object.hasOwn(aliases, row.hash))
      throw new Error(`Tooltip ${row.hash} is an alias. Select the original tooltip.`);
}

export function isTranslationPublishPayload(
  value: ScopedPublishRequestPayload,
): value is TranslationPublishPayload {
  return 'scope' in value;
}

/** Like the existing decoder, with scoped push explicitly enabled at a target's verified aliases. */
export async function parseScopedPublishRequestPayload(
  value: unknown,
  aliases: Aliases,
): Promise<ScopedPublishRequestPayload> {
  if ((value as { scope?: unknown } | null)?.scope !== 'translations')
    return parsePublishRequestPayload(value);
  const payload = translationPublishPayloadSchema.parse(value);
  assertTranslationRoots(payload.rows, aliases);
  return payload;
}

export async function translationPublishIntentDigest(
  value: TranslationPublishIntent,
): Promise<string> {
  const { opId, kind, repo, dataBranch, liveBranch, requester, scope } = value;
  const rows = [...value.rows].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.kind === 'tooltip' && b.kind === 'tooltip' && a.hash !== b.hash) return a.hash - b.hash;
    if (a.kind === 'global' && b.kind === 'global' && a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0;
  });
  return translationReviewDigest({
    opId,
    kind,
    repo,
    dataBranch,
    liveBranch,
    requester: { id: requester.id },
    scope,
    rows,
  });
}

export function scopedPublishRequestIntentDigest(
  value: ScopedPublishRequestPayload,
): Promise<string> {
  return isTranslationPublishPayload(value)
    ? translationPublishIntentDigest(value)
    : publishRequestIntentDigest(value);
}

/** The signed review facts use the same canonical JSON and SHA-256 as ordinary pushes. */
export async function translationReviewDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
