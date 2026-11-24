import { translationMaxAge } from '../exportLegacy.js';
import type { Lang } from '../languages.js';
import { scanBaseEnhanced } from '../markup/baseEnhanced.js';
import { lowerConsumerMarkup, variableReferences } from '../markup/braces.js';
import { markupCommentContext, removeMarkupComments } from '../markup/comments.js';
import { findElementTags } from '../markup/elementTags.js';
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
  generatedStructure: 'Write imports and block syntax directly instead of using a global variable.',
  noteReference: 'Write the shared note name directly inside the title tag.',
  elementTag: 'Place the global value outside the element tag when it contains markup.',
  unclosedBlock: 'Close the block before using a shared note.',
  nativePair: 'Keep both arms of the base/enhanced pair valid after filling in globals.',
  commentedImport: 'Remove the global import from the comment.',
  cyclicExport: 'Remove the cycle between named global exports.',
  missingExport: 'Choose an existing named global export.',
  missingTranslation: 'Add or update the translation for this global.',
} as const;

const importLine = /^import ([A-z0-9 ]+?) from (\d+|global) *$/gm;
const titleTag = /<title\b.*?(?:\/>|$)/gm;
const blockOpen = /^(?:export .+|title .+|enhanced|catalyst|exotic perk) \( *$/;
const blockClose = /^\) *$/;
const declaration = /^ *(?:var |(?:export .+|title .+|enhanced|catalyst|exotic perk) \( *$)/m;
const structuralLine =
  /^(?:var [A-Za-z0-9]+ = (?=[^\S\r\n]*\S)|(?:import (?:[A-z0-9 ]+? from (?:\d+|global)|self) *|(?:export .+|title .+|enhanced|catalyst|exotic perk) \( *|\) *)$)/gm;
const arrow = '🡅';

function blockDepth(line: string, depth: number): number {
  if (blockOpen.test(line)) return depth + 1;
  if (blockClose.test(line)) return Math.max(0, depth - 1);
  return depth;
}

/** The publisher checks these sites against transitive imports of generated note blocks. */
export function ordinaryImportsInBlocks(
  source: string,
): ({ part: 'main' | 'secondary'; target: string } | { part: 'self' })[] {
  if (!source.includes('import ')) return [];
  const imports: ReturnType<typeof ordinaryImportsInBlocks> = [];
  let depth = 0;
  for (const line of removeMarkupComments(source).split('\n')) {
    if (depth) {
      const target = /^import +(main|secondary) +from (\d+) *$/.exec(line);
      if (target) imports.push({ part: target[1] as 'main' | 'secondary', target: target[2] });
      if (/^import self *$/.test(line)) imports.push({ part: 'self' });
    }
    depth = blockDepth(line, depth);
  }
  return imports;
}

export const globalNoteImportInBlockMessage = (name: string) =>
  `Move the import of ${name} out of the block: it uses a shared note.`;

function noteNames(text: string): string[] {
  return [...text.matchAll(titleTag)].flatMap(([tag]) => {
    const target = /\[.+\]/.exec(tag)?.[0];
    return target ? [target.replace(/[[\]]/g, '')] : [];
  });
}

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
    const body = kind === 'variables' ? selected.body.trim() : selected.body;
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
    const elements = findElementTags(text);
    const remaining: string[] = [];
    let result = '';
    let at = 0;
    for (const { name, from, to } of refs) {
      const body =
        name !== 'e' && !hidden.some((comment) => from >= comment.from && from < comment.to)
          ? lookup('variables', name)
          : undefined;
      if (body === undefined) {
        remaining.push(name);
        continue;
      }
      if (
        text[from - 1] === '<' ||
        ((!body.trim() || /[<|[\]]/.test(body)) &&
          elements.some((tag) => from >= tag.from && to <= tag.to))
      )
        issue(globalsInPlaceMessages.elementTag);
      result += text.slice(at, from) + body;
      at = to;
    }
    if (!at) return text;
    result += text.slice(at);
    if (
      variableReferences(result)
        .map(({ name }) => name)
        .join(',') !== remaining.join(',')
    )
      issue(globalsInPlaceMessages.generatedReference);
    if (
      (text.match(structuralLine) ?? []).join('\n') !==
        (result.match(structuralLine) ?? []).join('\n') ||
      hidden.map(({ from, to }) => text.slice(from, to)).join('\n') !==
        comments(result)
          .map(({ from, to }) => result.slice(from, to))
          .join('\n')
    )
      issue(globalsInPlaceMessages.generatedStructure);
    return result;
  }

  let text = variables(imports(source));
  if (definitions.titles && (text.includes('<title') || text.includes('title '))) {
    const visible = removeMarkupComments(text);
    for (const block of Object.values(extractBlocks(visible, 'export')))
      if (noteNames(block).some((name) => Object.hasOwn(definitions.titles!, name)))
        issue(globalsInPlaceMessages.noteInExport);
    if (
      /^var [A-Za-z0-9]+ = .*<title\b/m.test(visible) ||
      [...visible.matchAll(titleTag)].some(([tag]) => {
        const target = /\[.+\]/.exec(tag)?.[0];
        return variableReferences(target ?? tag).some(({ name }) => name !== 'e');
      })
    )
      issue(globalsInPlaceMessages.noteReference);
    const local = extractBlocks(visible, 'title');
    const names = new Set(noteNames(visible));
    const blocks = [];
    for (const name of Object.keys(local))
      if (Object.hasOwn(definitions.titles, name) && !names.has(name))
        issue(globalsInPlaceMessages.localNote, name);
    for (const name of names) {
      if (!Object.hasOwn(definitions.titles, name)) continue;
      const body = lookup('titles', name);
      if (body === undefined) continue;
      const substituted = variables(body);
      if (substituted !== body) {
        for (const message of validateGlobalsInPlaceDefinition('titles', substituted, definitions))
          issue(message, name);
      }
      // The readers strip comments greedily and apply the caller's arrow rule to local notes.
      const filled = removeMarkupComments(substituted)
        .replace(/<enhanced\/>|#\{e\}|#e(?![A-Za-z0-9])/g, arrow)
        .trim();
      if (!Object.hasOwn(local, name)) blocks.push(`title ${name} (\n${filled}\n)`);
      else if (lowerConsumerMarkup(local[name].trim()) !== lowerConsumerMarkup(filled))
        issue(globalsInPlaceMessages.localNote, name);
    }
    if (blocks.length) {
      if (visible.split('\n').reduce((depth, line) => blockDepth(line, depth), 0))
        issue(globalsInPlaceMessages.unclosedBlock);
      text += `\n${blocks.join('\n')}`;
    }
  }
  if (
    text !== source &&
    text.includes('{{') &&
    scanBaseEnhanced(removeMarkupComments(text)).issues.length
  )
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
  if (hash === 2) return `var e = ${arrow}`;
}
