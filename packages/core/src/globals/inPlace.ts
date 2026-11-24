import { translationMaxAge } from '../exportLegacy.js';
import type { Lang } from '../languages.js';
import { scanBaseEnhanced } from '../markup/baseEnhanced.js';
import { lowerConsumerMarkup, variableReferences } from '../markup/braces.js';
import { markupCommentContext, removeMarkupComments } from '../markup/comments.js';
import { extractBlocks } from '../markup/syntax.js';
import type { GlobalRecord } from './model.js';

type Kind = GlobalRecord['kind'];
type Definition = { body: string; updatedAt?: string; sourceUpdatedAt?: string };
type Definitions = Readonly<Partial<Record<Lang, Definition>>>;
export type GlobalsInPlaceDefinitions = Readonly<
  Partial<Record<Kind, Readonly<Record<string, Definitions>>>>
>;
export interface GlobalsInPlaceOptions {
  definitions: GlobalsInPlaceDefinitions;
  missingTranslation?: 'english' | 'reject';
}

export const globalsInPlaceMessages = {
  aggregateImport: 'Refer to the global by name instead of importing tooltip 1, 2, or 3.',
  wholeGlobalImport: 'Import a named global export instead of the entire global library.',
  noteInExport: 'Move the global note out of the named tooltip export.',
  numberToken: 'Write the number directly in the global definition.',
  variableBody:
    'Use a single line of text without variable references or declarations for the global variable.',
  nestedBlock: 'Remove variable declarations and nested blocks from the global definition.',
  noteBody: 'Remove imports and nested note references from the global note.',
  localVariable: 'Use a global variable in the global definition.',
  localNote: 'Rename the local title so it has a different name from the global note.',
  generatedReference:
    'Separate the global variable from nearby markup so its value cannot create another reference.',
  nativePair: 'Keep both arms of the base/enhanced pair valid after filling in globals.',
  commentedImport: 'Remove the global import from the comment.',
  cyclicExport: 'Remove the cycle between named global exports.',
  missingExport: 'Choose an existing named global export.',
  missingTranslation: 'Add or update the translation for this global.',
} as const;

const importLine = /^import ([A-z0-9 ]+?) from (\d+|global) *$/gm;
const titleTag = /<title .*? \[([^\]\n]+)\] \/>/g;
const declaration = /^ *(?:var |(?:export .+|title .+|enhanced|catalyst|exotic perk) \( *$)/m;

/** Run on definition bodies at save time as well as when a definition is used. */
export function validateGlobalsInPlaceDefinition(
  kind: Kind,
  body: string,
  definitions: GlobalsInPlaceDefinitions,
): string[] {
  const issues: string[] = [];
  const visible = removeMarkupComments(body);
  if (body.includes('#{=')) issues.push(globalsInPlaceMessages.numberToken);
  if (kind === 'variables') {
    if (
      /[\r\n]/.test(body) ||
      variableReferences(body).length ||
      declaration.test(visible) ||
      visible.search(importLine) !== -1
    )
      issues.push(globalsInPlaceMessages.variableBody);
  } else {
    if (declaration.test(visible) || /^\) *$/m.test(visible))
      issues.push(globalsInPlaceMessages.nestedBlock);
    if (kind === 'titles' && (/^import /m.test(visible) || [...visible.matchAll(titleTag)].length))
      issues.push(globalsInPlaceMessages.noteBody);
    if (
      variableReferences(visible).some(
        ({ name }) => name !== 'e' && !Object.hasOwn(definitions.variables ?? {}, name),
      )
    )
      issues.push(globalsInPlaceMessages.localVariable);
  }
  return issues;
}

function inline(
  source: string,
  language: Lang,
  { definitions, missingTranslation = 'english' }: GlobalsInPlaceOptions,
) {
  const issues = new Set<string>();
  const issue = (message: string, name?: string) =>
    issues.add(name ? `${message} (${name})` : message);
  const expanding = new Set<string>();
  const lookup = (kind: Kind, name: string): string | undefined => {
    const entries = definitions[kind];
    const entry = entries && Object.hasOwn(entries, name) ? entries[name] : undefined;
    if (!entry) {
      if (kind === 'exports') issue(globalsInPlaceMessages.missingExport, name);
      return;
    }
    const english = entry.en;
    let selected = entry[language];
    if (
      selected?.sourceUpdatedAt &&
      english?.updatedAt &&
      Date.parse(english.updatedAt) - Date.parse(selected.sourceUpdatedAt) > translationMaxAge
    )
      selected = undefined;
    if (!selected && missingTranslation === 'english') selected = english;
    if (!selected) {
      issue(globalsInPlaceMessages.missingTranslation, name);
      return;
    }
    const body = selected.body.trim();
    const definitionIssues = validateGlobalsInPlaceDefinition(kind, selected.body, definitions);
    for (const message of definitionIssues) issue(message, name);
    if (definitionIssues.length) return;
    return kind === 'variables' && body === 'empty' ? '' : body;
  };
  const comments = (text: string) =>
    /\/\*|\/\//.test(text) ? markupCommentContext(text).comments : [];
  function imports(text: string): string {
    if (!text.includes('import ')) return text;
    const hidden = comments(text);
    return text.replace(importLine, (line, rawName: string, library: string, from: number) => {
      const name = rawName.trim();
      if (library !== 'global') {
        if (/^0*[123]$/.test(library)) issue(globalsInPlaceMessages.aggregateImport);
        return line;
      }
      if (hidden.some((comment) => from >= comment.from && from < comment.to)) {
        issue(globalsInPlaceMessages.commentedImport);
        return line;
      }
      if (name === 'main' || name === 'secondary') {
        issue(globalsInPlaceMessages.wholeGlobalImport);
        return line;
      }
      if (expanding.has(name)) {
        issue(globalsInPlaceMessages.cyclicExport, name);
        return line;
      }
      const body = lookup('exports', name);
      if (body === undefined) return line;
      expanding.add(name);
      const expanded = imports(body);
      expanding.delete(name);
      return expanded;
    });
  }
  function variables(text: string): string {
    if (!text.includes('#') || !definitions.variables) return text;
    const hidden = comments(text);
    const refs = variableReferences(text);
    let result = '';
    let at = 0;
    for (const { name, from, to } of refs) {
      if (name === 'e' || hidden.some((comment) => from >= comment.from && from < comment.to))
        continue;
      const body = lookup('variables', name);
      if (body === undefined) continue;
      result += text.slice(at, from) + body;
      at = to;
    }
    return at === 0 ? text : result + text.slice(at);
  }

  let text = variables(imports(source));
  if (text !== source && (variables(text) !== text || imports(text) !== text))
    issue(globalsInPlaceMessages.generatedReference);
  if (text.includes('<title ') && definitions.titles) {
    const visible = removeMarkupComments(text);
    const names = (value: string) => [...value.matchAll(titleTag)].map((match) => match[1]);
    for (const block of Object.values(extractBlocks(visible, 'export')))
      if (names(block).some((name) => Object.hasOwn(definitions.titles!, name)))
        issue(globalsInPlaceMessages.noteInExport);
    const local = extractBlocks(visible, 'title');
    const blocks = [];
    for (const name of new Set(names(visible))) {
      if (!Object.hasOwn(definitions.titles, name)) continue;
      const body = lookup('titles', name);
      if (body === undefined) continue;
      const filled = variables(body);
      if (filled !== body) {
        for (const message of validateGlobalsInPlaceDefinition('titles', filled, definitions))
          issue(message, name);
        if (variables(filled) !== filled) issue(globalsInPlaceMessages.generatedReference);
      }
      if (!Object.hasOwn(local, name)) blocks.push(`title ${name} (\n${filled}\n)`);
      else if (
        lowerConsumerMarkup(local[name].trim()) !==
        removeMarkupComments(lowerConsumerMarkup(filled)).trim()
      )
        issue(globalsInPlaceMessages.localNote, name);
    }
    if (blocks.length) text += `\n\n${blocks.join('\n\n')}`;
  }
  if (text !== source && text.includes('{{') && scanBaseEnhanced(text).issues.length)
    issue(globalsInPlaceMessages.nativePair);
  return { text, issues: [...issues] };
}

export function validateGlobalsInPlaceSource(
  source: string,
  language: Lang,
  options: GlobalsInPlaceOptions,
): string[] {
  return inline(source, language, options).issues;
}

/** Resolve one selected language/part after number resolution, before lowering consumer markup. */
export function resolveGlobalsInPlace(
  source: string,
  language: Lang,
  options: GlobalsInPlaceOptions,
): string {
  const { text, issues } = inline(source, language, options);
  if (issues.length) throw new Error(issues.join(' '));
  return text;
}

/** Keep the reserved library rows present for readers of the published format. */
export function globalsInPlaceLibraryText(hash: number): string | undefined {
  if (hash === 1 || hash === 3) return '';
  if (hash === 2) return 'var e = 🡅';
}
