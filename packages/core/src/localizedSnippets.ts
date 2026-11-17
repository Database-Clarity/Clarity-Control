import { z } from 'zod';
import { markupSnippets, markupTags } from './markup/snippets.js';
import { teamSnippetIdSchema } from './customSnippets.js';
import { langSchema } from './languages.js';

export const localizedSnippetLangSchema = langSchema.refine((lang) => lang !== 'en');
export const localizableBuiltIns = [...markupSnippets, ...markupTags];
export const localizedSnippetIdSchema = z.union([
  z.string().refine((id) => localizableBuiltIns.some((s) => s.id === id)),
  teamSnippetIdSchema,
]);
export const snippetTranslationSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    keywords: z.string().max(2000),
    template: z.string().min(1).max(2000),
    enHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SnippetTranslation = z.infer<typeof snippetTranslationSchema>;
export const snippetTranslationsSchema = z.record(
  localizedSnippetIdSchema,
  snippetTranslationSchema,
);
export const snippetTranslationChangeSchema = z
  .object({
    id: localizedSnippetIdSchema,
    base: snippetTranslationSchema.nullable(),
    next: snippetTranslationSchema.nullable(),
  })
  .strict();
export type SnippetTranslationChange = z.infer<typeof snippetTranslationChangeSchema>;

export class SnippetSkeletonError extends Error {
  constructor(message = 'Translated snippet must preserve the English template skeleton') {
    super(message);
    this.name = 'SnippetSkeletonError';
  }
}

/** Words may change; syntax, declaration identities, reference targets, and stops may not.
 * Mark stops before scanning so their defaults are treated in their markup context:
 * a tag-name or reference-target default is syntax, while a prose default is translatable.
 */
function skeleton(template: string): string {
  const text = template.replace(
    /\{\{(\d+)(?::((?:[^{}]|\{(?!\{))*?))?\}\}/g,
    (_match, n: string, value: string | undefined) => `\u0001${n}\u0002${value ?? ''}\u0003`,
  );
  const ranges: { from: number; to: number }[] = [];
  const protect = (pattern: RegExp, accept: (at: number) => boolean = () => true) => {
    for (const match of text.matchAll(pattern))
      if (accept(match.index))
        ranges.push({ from: match.index, to: match.index + match[0].length });
  };
  // eslint-disable-next-line no-control-regex -- Internal stop delimiters, rejected in user input.
  protect(/<(?:\w+|\u0001[^\u0003]*\u0003)/g);
  protect(/#\{[^}\r\n]*\}/g);
  protect(/\$\{(?:#\{[^}]*\}|[^}])*\}/g);
  protect(
    /^[\t ]*(?:var[\t ]+[^\r\n=]+[\t ]*=|(?:title|export)[\t ]+[^\r\n(]+[\t ]*\(|import[\t ]+[^\r\n]+|enhanced[\t ]*\()/gm,
  );
  protect(/\[[^\]\r\n]*\]/g, (at) => {
    const start = text.lastIndexOf('<', at);
    return start > text.lastIndexOf('>', at) && /^<(?:title|link)\b/.test(text.slice(start));
  });
  ranges.sort((a, b) => a.from - b.from);
  const words = (part: string) => part.replace(/[\p{L}\p{M}\t ]+/gu, '');
  let result = '';
  let end = 0;
  for (const range of ranges) {
    if (range.to <= end) continue;
    if (range.from > end) result += words(text.slice(end, range.from));
    result += text.slice(Math.max(end, range.from), range.to);
    end = range.to;
  }
  return result + words(text.slice(end));
}

export function validateSnippetTranslation(english: string, translated: string): void {
  if (
    english.length > 2000 ||
    translated.length > 2000 ||
    (translated.match(/</g)?.length ?? 0) > 100 ||
    (translated.match(/#\{/g)?.length ?? 0) > 100 ||
    /\s{41}/.test(translated)
  )
    throw new SnippetSkeletonError('Translated template exceeds snippet bounds');
  if (
    // eslint-disable-next-line no-control-regex -- Reject control characters, including internal stop delimiters.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(translated) ||
    skeleton(english) !== skeleton(translated)
  )
    throw new SnippetSkeletonError();
}

/** SHA-256 over the exact English template, including its line endings. */
export async function snippetEnglishHash(template: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(template));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

export const effectiveSnippetsResponseSchema = z.object({
  snippets: z.array(
    z.object({
      id: localizedSnippetIdSchema,
      label: z.string(),
      keywords: z.string(),
      template: z.string(),
      enHash: z.string(),
      language: langSchema,
      hint: z.literal('EN').nullable(),
      outdated: z.boolean(),
    }),
  ),
  translations: snippetTranslationsSchema,
  outdated: z.array(localizedSnippetIdSchema),
  canManage: z.boolean(),
});
export type EffectiveSnippetsResponse = z.infer<typeof effectiveSnippetsResponseSchema>;
