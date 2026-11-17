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
export const snippetTranslationSchema = z.object({
  label: z.string().trim().min(1).max(40),
  keywords: z.string().max(2000),
  template: z.string().min(1).max(2000),
  enHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SnippetTranslation = z.infer<typeof snippetTranslationSchema>;
export const snippetTranslationsSchema = z.record(localizedSnippetIdSchema, snippetTranslationSchema);
export const snippetTranslationChangeSchema = z.object({
  id: localizedSnippetIdSchema,
  base: snippetTranslationSchema.nullable(),
  next: snippetTranslationSchema.nullable(),
}).strict();
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
  const text = template.replace(/\{\{(\d+)(?::((?:[^{}]|\{(?!\{))*?))?\}\}/g,
    (_match, n: string, value: string | undefined) => `\u0001${n}\u0002${value ?? ''}\u0003`);
  const protectedChars = new Uint8Array(text.length);
  const protect = (pattern: RegExp, accept: (at: number) => boolean = () => true) => {
    for (const match of text.matchAll(pattern))
      if (accept(match.index)) protectedChars.fill(1, match.index, match.index + match[0].length);
  };
  protect(/<(?:\w+|\u0001[^\u0003]*\u0003)/g);
  protect(/#\{[^}\r\n]*\}/g);
  protect(/\$\{(?:#\{[^}]*\}|[^}])*\}/g);
  protect(/^[\t ]*(?:var[\t ]+[^\r\n=]+[\t ]*=|(?:title|export)[\t ]+[^\r\n(]+[\t ]*\(|import[\t ]+[^\r\n]+|enhanced[\t ]*\()/gm);
  protect(/\[[^\]\r\n]*\]/g, (at) => {
    const start = text.lastIndexOf('<', at);
    return start > text.lastIndexOf('>', at) && /^<(?:title|link)\b/.test(text.slice(start));
  });
  let result = '';
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (end < text.length && protectedChars[end] === protectedChars[start]) end++;
    const part = text.slice(start, end);
    result += protectedChars[start] ? part : part.replace(/[\p{L}\p{M}\t ]+/gu, '');
    start = end;
  }
  return result;
}

export function validateSnippetTranslation(english: string, translated: string): void {
  if (english.length > 2000 || translated.length > 2000 ||
    (translated.match(/</g)?.length ?? 0) > 100 ||
    (translated.match(/#\{/g)?.length ?? 0) > 100 || /\s{41}/.test(translated))
    throw new SnippetSkeletonError('Translated template exceeds snippet bounds');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(translated) ||
    skeleton(english) !== skeleton(translated)) throw new SnippetSkeletonError();
}

/** SHA-256 over the exact English template, including its line endings. */
export async function snippetEnglishHash(template: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(template));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

export const effectiveSnippetsResponseSchema = z.object({
  snippets: z.array(z.object({
    id: localizedSnippetIdSchema,
    label: z.string(),
    keywords: z.string(),
    template: z.string(),
    enHash: z.string(),
    language: langSchema,
    hint: z.literal('EN').nullable(),
    outdated: z.boolean(),
  })),
  translations: snippetTranslationsSchema,
  outdated: z.array(localizedSnippetIdSchema),
  canManage: z.boolean(),
});
export type EffectiveSnippetsResponse = z.infer<typeof effectiveSnippetsResponseSchema>;
