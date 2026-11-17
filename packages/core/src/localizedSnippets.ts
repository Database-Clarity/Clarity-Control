import { z } from 'zod';
import { expandTemplate, markupSnippets, markupTags } from './markup/snippets.js';
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
/** Keep retired catalogue entries readable and removable across Worker/Pages rollouts. */
export const storedLocalizedSnippetIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/)
  .refine((id) => !['constructor', 'prototype'].includes(id));
export const snippetTranslationsSchema = z.record(
  storedLocalizedSnippetIdSchema,
  snippetTranslationSchema,
);
export const snippetTranslationChangeSchema = z
  .object({
    id: storedLocalizedSnippetIdSchema,
    base: snippetTranslationSchema.nullable(),
    next: snippetTranslationSchema.nullable(),
  })
  .strict()
  .refine(
    (change) => !change.next || localizedSnippetIdSchema.safeParse(change.id).success,
    'Only current built-in and team snippet ids may receive translations',
  );
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
  protect(/#[A-Za-z0-9]+/g);
  protect(/\$\{(?:#\{[^}]*\}|[^}])*\}/g);
  protect(
    /^[\t ]*(?:var[\t ]+[^\r\n=]+[\t ]*=(?:[\t ]+empty[\t ]*\r?$)?|(?:title|export)[\t ]+[^\r\n(]+[\t ]*\(|import[\t ]+[^\r\n]+|(?:enhanced|catalyst|exotic perk)[\t ]*\()/gm,
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

function checkBounds(template: string): void {
  if (
    template.length > 2000 ||
    (template.match(/</g)?.length ?? 0) > 100 ||
    (template.match(/#\{/g)?.length ?? 0) > 100 ||
    (template.match(/\$\{/g)?.length ?? 0) > 100 ||
    /\s{41}/.test(template)
  )
    throw new SnippetSkeletonError('Translated template exceeds snippet bounds');
}

export function validateSnippetTranslation(english: string, translated: string): void {
  checkBounds(english);
  checkBounds(translated);
  if (
    // eslint-disable-next-line no-control-regex -- Reject control characters, including internal stop delimiters.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(translated) ||
    skeleton(english) !== skeleton(translated)
  )
    throw new SnippetSkeletonError();
  // Defaults may supply a declaration head, a tag name, or part of a reference.
  // Keep the marker comparison above for stops, and check their actual markup too.
  const expandedEnglish = expandTemplate(english).text;
  const expandedTranslation = expandTemplate(translated).text;
  checkBounds(expandedEnglish);
  checkBounds(expandedTranslation);
  if (skeleton(expandedEnglish) !== skeleton(expandedTranslation)) throw new SnippetSkeletonError();
}

/** SHA-256 over the exact English template, including its line endings. */
export async function snippetEnglishHash(template: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(template));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

export const effectiveSnippetsResponseSchema = z.object({
  snippets: z.array(
    z.object({
      id: storedLocalizedSnippetIdSchema,
      label: z.string(),
      keywords: z.string(),
      template: z.string(),
      enHash: z.string(),
      language: langSchema,
      hint: z.literal('EN').nullable(),
      outdated: z.boolean(),
    }),
  ),
  outdated: z.array(storedLocalizedSnippetIdSchema),
  canManage: z.boolean(),
});
export type EffectiveSnippetsResponse = z.infer<typeof effectiveSnippetsResponseSchema>;
