import { translationMaxAge } from '../exportLegacy.js';
import type { Lang } from '../languages.js';
import { lowerConsumerMarkup, variableReferences } from '../markup/braces.js';
import { removeMarkupComments } from '../markup/comments.js';
import { parseLines } from '../markup/lines.js';
import { markupConditions, prepareMarkup } from '../markup/prepare.js';
import { extractBlocks } from '../markup/syntax.js';
import type { MarkupGlobals } from '../markup/types.js';
import type { GlobalRecord } from './model.js';

type Kind = GlobalRecord['kind'];
type Definition = { body: string; updatedAt?: string; sourceUpdatedAt?: string };
type LocalizedDefinition = Readonly<Partial<Record<Lang, Definition>>>;
export type GlobalsInPlaceDefinitions = Readonly<
  Partial<Record<Kind, Readonly<Record<string, LocalizedDefinition>>>>
>;
export interface GlobalsInPlaceOptions {
  definitions: GlobalsInPlaceDefinitions;
  missingTranslation?: 'english' | 'reject';
}

/** Observe which shared note names the real markup resolver reads from a cell. */
export function effectiveSharedNotes(
  source: string,
  globals: MarkupGlobals,
  names: ReadonlySet<string>,
): string[] {
  if (!names.size) return [];
  const reads = new Set<string>();
  const titles = new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key === 'string' && names.has(key)) reads.add(key);
      return undefined;
    },
  });
  const variants = new Set<string>();
  const observe = (type?: string) => {
    const { text } = prepareMarkup(source, { ...globals, type }, [], (condition) => {
      variants.add(condition);
    });
    parseLines(text, titles);
  };
  observe(globals.type);
  if (globals.type === undefined)
    for (const [keyword, type] of markupConditions) if (variants.has(keyword)) observe(type);
  return [...reads];
}

/** Resolve one selected language/part after number resolution, before lowering consumer markup. */
export function resolveGlobalsInPlace(
  source: string,
  language: Lang,
  { definitions, missingTranslation = 'english' }: GlobalsInPlaceOptions,
): string {
  const lookup = (kind: Kind, name: string, needed = true): string | undefined => {
    const entries = definitions[kind];
    if (!entries || !Object.hasOwn(entries, name)) return;
    const entry = entries[name];
    const english = entry.en;
    let selected = entry[language];
    if (
      selected?.sourceUpdatedAt &&
      english?.updatedAt &&
      Date.parse(english.updatedAt) - Date.parse(selected.sourceUpdatedAt) > translationMaxAge
    )
      selected = undefined;
    if (!selected && missingTranslation === 'english') selected = english;
    if (!selected && needed) throw new Error(`Add or update the translation for shared ${name}.`);
    return selected?.body;
  };

  const active = new Set<string>();
  const expand = (text: string): string =>
    text.replace(/^import ([A-z0-9 ]+?) from global *$/gm, (_line, rawName: string) => {
      const name = rawName.trim();
      if (active.has(name)) throw new Error(`Remove the cycle in shared export ${name}.`);
      const body = lookup('exports', name);
      if (body === undefined) throw new Error(`Choose an existing shared export for ${name}.`);
      active.add(name);
      const expanded = expand(body);
      active.delete(name);
      return expanded;
    });
  const fill = (text: string): string => {
    let result = '';
    let at = 0;
    for (const { name, from, to } of variableReferences(text)) {
      if (name === 'e') continue;
      const body = lookup('variables', name)?.trim();
      if (body === undefined) continue;
      result += text.slice(at, from) + (body === 'empty' ? '' : body);
      at = to;
    }
    return at ? result + text.slice(at) : text;
  };

  const expanded = source.includes('import ') ? expand(source) : source;
  const text = fill(expanded);
  const names = new Set(Object.keys(definitions.titles ?? {}));
  if (!names.size || !source) return text;
  const variables = Object.keys(definitions.variables ?? {}).flatMap((name) => {
    const body = lookup('variables', name, false);
    return name !== 'e' && body !== undefined ? [`var ${name} = ${body.trim() || 'empty'}`] : [];
  });
  const noteBlock = (name: string, body: string) => `title ${name} (\n${body}\n)`;
  const titles = [...names].flatMap((name) => {
    const body = lookup('titles', name, false);
    return body === undefined ? [] : [noteBlock(name, body)];
  });
  const reads = effectiveSharedNotes(
    lowerConsumerMarkup(expanded),
    {
      variables: lowerConsumerMarkup([globalsInPlaceLibraryText(2), ...variables].join('\n')),
      titles: lowerConsumerMarkup(titles.join('\n')),
      lang: language,
    },
    names,
  );
  const local = extractBlocks(text.replace(/\r/g, ''), 'title');
  const blocks = reads.flatMap((name) => {
    if (Object.hasOwn(local, name)) return [];
    const body = lookup('titles', name)!;
    // Previously each note was prepared independently, outside the cell's arrow and comment rules.
    const filled = removeMarkupComments(fill(body))
      .replace(/<enhanced\/>|#\{e\}|#e(?![A-Za-z0-9])/g, '🡅')
      .trim();
    return [noteBlock(name, filled)];
  });
  // A preceding note is outside the cell's later comments and open blocks.
  return blocks.length ? `${blocks.join('\n')}\n${text}` : text;
}

/** Keep the reserved library rows present for readers of the published format. */
export function globalsInPlaceLibraryText(hash: number): string | undefined {
  if (hash === 1 || hash === 3) return '';
  if (hash === 2) return 'var e = 🡅';
}
