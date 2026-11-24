import { translationMaxAge } from '../exportLegacy.js';
import type { Lang } from '../languages.js';
import { lowerConsumerMarkup, variableReferences } from '../markup/braces.js';
import { removeMarkupComments } from '../markup/comments.js';
import { parseLines } from '../markup/lines.js';
import { markupConditions, prepareMarkup } from '../markup/prepare.js';
import { extractBlocks, extractVariables } from '../markup/syntax.js';
import { globalReferenceSpans } from './references.js';
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
  onRead?: (kind: Kind, name: string, language: Lang, body: string | undefined) => void;
}

/** Shared authored-content guard, independent of the selected translation or render preset. */
export function globalsInPlaceSaveIssue(
  source: string,
  titleNames?: ReadonlySet<string>,
): string | undefined {
  const text = removeMarkupComments(source.replace(/\r/g, ''));
  if (
    /^import [A-z0-9 ]+? from 0*[123] *$/m.test(text) ||
    /^import (main|secondary) from global *$/m.test(text)
  )
    return 'Use a shared export by name or reference the shared variable or note directly.';
  if (
    titleNames?.size &&
    Object.values(extractBlocks(text, 'export')).some((body) =>
      globalReferenceSpans(body, 'titles').some(({ name }) => titleNames.has(name)),
    )
  )
    return 'Move the shared note outside the named export.';
}

/** Build resolver inputs from the saved catalogue, excluding withdrawn entries. */
export function globalsInPlaceDefinitions(
  entries: readonly GlobalRecord[],
): GlobalsInPlaceDefinitions {
  const result: Record<Kind, Record<string, LocalizedDefinition>> = {
    exports: Object.create(null),
    variables: Object.create(null),
    titles: Object.create(null),
  };
  for (const entry of entries)
    if (!entry.tombstone) result[entry.kind][entry.name] = entry.definitions;
  return result;
}

/** The migration uses each LIVE library's two stored parts, in reader precedence order. */
export function legacyGlobalsInPlaceDefinitions(
  perks: Readonly<
    Record<string, { editor?: Partial<Record<Lang, { main: string; secondary: string }>> }>
  >,
): GlobalsInPlaceDefinitions {
  const result: Record<Kind, Record<string, Partial<Record<Lang, Definition>>>> = {
    exports: Object.create(null),
    variables: Object.create(null),
    titles: Object.create(null),
  };
  for (const [hash, kind] of [
    [1, 'exports'],
    [2, 'variables'],
    [3, 'titles'],
  ] as const) {
    const editor = perks[hash]?.editor;
    if (!editor && hash !== 1) throw new Error(`Missing LIVE library ${hash}`);
    for (const [language, cell] of Object.entries(editor ?? {}))
      for (const source of [cell.main, cell.secondary]) {
        const text = source.replace(/\r/g, '');
        const bodies =
          kind === 'variables'
            ? extractVariables(text)
            : extractBlocks(text, kind === 'exports' ? 'export' : 'title');
        for (const [name, body] of Object.entries(bodies)) {
          const definitions = (result[kind][name] ??= {});
          definitions[language as Lang] = { body };
        }
      }
  }
  return result;
}

export function globalsInPlaceDefinition(
  entry: LocalizedDefinition,
  language: Lang,
  missingTranslation: GlobalsInPlaceOptions['missingTranslation'] = 'english',
): Definition | undefined {
  const english = entry.en;
  let selected = entry[language];
  if (
    selected?.sourceUpdatedAt &&
    english?.updatedAt &&
    Date.parse(english.updatedAt) - Date.parse(selected.sourceUpdatedAt) > translationMaxAge
  )
    selected = undefined;
  return selected ?? (missingTranslation === 'english' ? english : undefined);
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
  { definitions, missingTranslation = 'english', onRead }: GlobalsInPlaceOptions,
): string {
  const lookup = (kind: Kind, name: string, needed = true): string | undefined => {
    const entries = definitions[kind];
    if (!entries || !Object.hasOwn(entries, name)) {
      if (needed) onRead?.(kind, name, language, undefined);
      return;
    }
    const selected = globalsInPlaceDefinition(entries[name], language, missingTranslation);
    if (needed) onRead?.(kind, name, language, selected?.body);
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
