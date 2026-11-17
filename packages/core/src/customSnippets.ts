import { z } from 'zod';
import { expandTemplate, markupSnippets, markupTags } from './markup/snippets.js';
import { validateText } from './validation/index.js';
import { variableReferences, enhancedArrowMarkup } from './markup/braces.js';
import { markupColors, markupEmpty, markupIcons, markupLineClasses } from './markup/syntax.js';
import { removeMarkupComments, markupImports, markupConditionMatches } from './markup/prepare.js';
import { extractBlocks } from './markup/syntax.js';
import { enhancedMarkupType } from './markup/baseEnhanced.js';

export const snippetsPath = 'config/snippets.json';
export const personalSnippetIdSchema = z.string().regex(/^me:[a-zA-Z0-9-]{1,64}$/);
export const teamSnippetIdSchema = z.string().regex(/^team:[a-zA-Z0-9-]{1,64}$/);
const builtInLabels = new Set([...markupSnippets, ...markupTags].map((s) => s.label.toLowerCase()));
// This built-in is currently declared by the editor beside the core catalogue.
builtInLabels.add(enhancedArrowMarkup);

/** Save-time structural validation allows unresolved globals, titles, imports, and variables.
 * Editor roles (maintainer, editor, trial, and translator) have personal snippets; partners do not.
 * The editor's existing context checker remains the authority at actual insertion time.
 * Expansion and markup parsing reuse the built-in template expander and editor parser.
 */
export function snippetTemplateIssue(template: string): string | undefined {
  if (/\{\{(?:[1-9]\d*\}\}|0:)/.test(template)) return 'Template fields use {{n:default}} or {{0}}';
  const text = expandTemplate(template).text;
  const source = removeMarkupComments(text);
  if (/#\{(?![a-zA-Z0-9]+\})/.test(source)) return 'Malformed variable: write #{name}';
  for (const line of source.split('\n')) {
    if (/^import\b/.test(line) && !markupImports(line).includes(line))
      return 'Malformed import declaration';
  }
  for (const kind of ['title', 'export'] as const) {
    const count = [...source.matchAll(new RegExp(`^${kind} .+ \\(`, 'gm'))].length;
    if (count !== Object.keys(extractBlocks(source, kind)).length)
      return `Unbalanced or duplicate ${kind} block`;
  }
  if (
    [...source.matchAll(/^enhanced \(/gm)].length !==
    markupConditionMatches(source, 'enhanced').length
  )
    return 'Unbalanced enhanced block';
  // The built-in math grammar allows braced variable references inside its outer braces.
  for (const math of source.matchAll(/\$\{/g)) {
    if (!/^\$\{(?:#\{[a-zA-Z0-9]+\}|[^{}\n])+\}/.test(source.slice(math.index)))
      return 'Unbalanced math expression';
  }
  const knownTags = new Set([
    ...markupColors,
    ...markupEmpty,
    ...markupIcons,
    ...markupLineClasses,
    'link',
    'title',
    'pve',
    'pvp',
    'enhanced',
  ]);
  for (const tag of source.matchAll(/<(\w+)/g)) {
    if (!knownTags.has(tag[1])) return `Unknown markup tag <${tag[1]}>`;
  }
  // Remaining double braces belong to the base/enhanced grammar, checked by parseMarkup.
  if (/\{\{\d+(?::|\}\})/.test(text)) return 'Malformed template field';
  for (const ref of variableReferences(source)) {
    // Link anchors (including the Enemy Rank seed) are reference targets, not variables.
    if (/\[[^\]\n]*$/.test(source.slice(0, ref.from))) continue;
    if (source.slice(ref.from, ref.to).startsWith('#{')) continue;
    return 'Write variables as #{name}, rather than #name';
  }
  const issue = [undefined, enhancedMarkupType]
    .flatMap((type) => validateText(text, 'en', { variables: '', titles: '', type }, false))
    .find(
      (issue) =>
        !issue.message.startsWith('Unknown variable ') &&
        !issue.message.startsWith('Unknown title ') &&
        !issue.message.startsWith('Unresolved import '),
    );
  return issue?.message;
}

export const snippetContentSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, 'Label is required')
      .max(40, 'Label must be at most 40 characters')
      .refine(
        (label) => !builtInLabels.has(label.toLowerCase()),
        'Label clashes with a built-in label',
      ),
    template: z
      .string()
      .min(1, 'Template is required')
      .max(2000, 'Template must be at most 2,000 characters')
      .superRefine((template, ctx) => {
        const issue = snippetTemplateIssue(template);
        if (issue) ctx.addIssue({ code: 'custom', message: issue });
      }),
    keywords: z.string().max(2000).optional(),
  })
  .strict();
export const customSnippetSchema = snippetContentSchema.extend({
  id: z.union([personalSnippetIdSchema, teamSnippetIdSchema]),
});
export const personalSnippetSchema = customSnippetSchema.extend({ id: personalSnippetIdSchema });
export const teamSnippetSchema = customSnippetSchema.extend({ id: teamSnippetIdSchema });
/** Bounded storage/read contract: save-time policy applies only to the new entry.
 * Avoid reparsing up to 200,000 characters on every unrelated team write, and retain
 * old entries if a built-in label is renamed later. Requests still validate new templates.
 */
export const storedSnippetSchema = z
  .object({
    id: z.union([personalSnippetIdSchema, teamSnippetIdSchema]),
    label: z.string().min(1).max(40),
    template: z.string().min(1).max(2000),
    keywords: z.string().max(2000).optional(),
  })
  .strict();
export const storedPersonalSnippetSchema = storedSnippetSchema.extend({
  id: personalSnippetIdSchema,
});
export const storedTeamSnippetSchema = storedSnippetSchema.extend({ id: teamSnippetIdSchema });
export type CustomSnippet = z.infer<typeof customSnippetSchema>;
export type SnippetContent = z.infer<typeof snippetContentSchema>;

/** Derived insertion facts, never accepted as writable flags from clients. */
export function customSnippetScope(template: string) {
  const text = expandTemplate(template).text;
  return {
    lineStart: /[\r\n]|^(?:var|title|export|import|enhanced)\b/.test(text),
    enhanced: /\{\{|<enhanced\/>|^enhanced \(/m.test(text),
    link: /<link /.test(text),
  };
}

export const teamSnippetsSchema = z
  .object({
    v: z.literal(1),
    snippets: z
      .array(storedTeamSnippetSchema)
      .max(100)
      .refine(
        (snippets) => new Set(snippets.map((s) => s.id)).size === snippets.length,
        'Duplicate snippet id',
      ),
  })
  .strict();
export const emptyTeamSnippets = () => ({ v: 1 as const, snippets: [] as CustomSnippet[] });
export const snippetChangeSchema = z
  .object({
    id: teamSnippetIdSchema,
    base: storedTeamSnippetSchema.nullable(),
    next: teamSnippetSchema.nullable(),
  })
  .strict()
  .refine(
    (op) => (!op.base || op.base.id === op.id) && (!op.next || op.next.id === op.id),
    'Snippet ids must match',
  );
export type SnippetChange = z.infer<typeof snippetChangeSchema>;
/** Offered to maintainers for explicit application later; never written automatically. */
export const teamSnippetSeeds: readonly CustomSnippet[] = [
  {
    id: 'team:refill-title',
    label: 'Refills (magazine)',
    template: '<title {{1:refills}} [G_refill] />',
    keywords: 'refill magazine',
  },
  {
    id: 'team:rank-link',
    label: 'Enemy Rank link',
    template: '<link {{1:Enemy Rank}} [#CombatantClassifications] />',
    keywords: 'enemy combatant rank',
  },
];
