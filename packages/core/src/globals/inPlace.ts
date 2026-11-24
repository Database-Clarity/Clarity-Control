import type { Tooltip } from '../schemas.js';
import {
  exportLegacy,
  isLegacyAliasStub,
  translationMaxAge,
  type LegacyEntry,
} from '../exportLegacy.js';
import type { Lang } from '../languages.js';
import { lowerConsumerMarkup, variableReferences } from '../markup/braces.js';
import { markupCommentContext, removeMarkupComments } from '../markup/comments.js';
import { parseLines } from '../markup/lines.js';
import { markupConditions, markupImports, prepareMarkup } from '../markup/prepare.js';
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
  unavailable?: Partial<Record<Kind, ReadonlySet<string>>>;
  importFallback?: (source: string, language: Lang) => MissingGlobalTranslation | undefined;
}

export class MissingGlobalTranslation extends Error {
  constructor(
    readonly kind: Kind,
    readonly globalName: string,
    readonly language: Lang,
    readonly reason: 'missing' | 'stale',
  ) {
    super(`Add or update the translation for shared ${globalName}.`);
    this.name = 'MissingGlobalTranslation';
  }
}

export class UnpublishedGlobal extends Error {
  constructor(
    readonly kind: Kind,
    readonly globalName: string,
  ) {
    super(`Publish the shared change for ${globalName} first.`);
  }
}

/** Both readers can consume a tag even when a comment boundary crosses it. */
function* tagVariables(source: string) {
  if (!source.includes('#') || !source.includes('<')) return;
  const uncommented = removeMarkupComments(source);
  const local = extractVariables(uncommented);
  for (const text of new Set([uncommented, source.replace(/\r/g, '')])) {
    const comments = text === uncommented ? [] : markupCommentContext(text).comments;
    for (const match of text.matchAll(/<(?:link|title)\b[^\n]*?(?:\/>|$)/gm)) {
      const [tag] = match;
      const end = match.index + tag.length;
      if (comments.some(({ from, to }) => from <= match.index && to >= end)) continue;
      const literal =
        !comments.some(({ from, to }) => from < end && match.index < to) &&
        /^[^[\]\n]*\[[^[\]<>\n]*\] *\/>$/.test(tag);
      const destination = literal ? tag.indexOf('[') : tag.length;
      const wholeLink =
        literal && /^<link .* \[#(?:[A-Za-z0-9]+|\{[A-Za-z0-9]+\})\] *\/>$/.test(tag);
      for (const { name, from } of variableReferences(tag))
        if (!Object.hasOwn(local, name))
          yield {
            name,
            destination: from > destination,
            wholeLink: wholeLink && from > destination,
          };
    }
  }
}

export function inPlaceLabelVariable(
  source: string,
  shared: ReadonlySet<string>,
  target?: string,
): string | undefined {
  for (const { name, destination, wholeLink } of tagVariables(source))
    if (target === undefined ? !destination || (!wholeLink && shared.has(name)) : name === target)
      return name;
}

export function inPlaceLinkVariables(source: string): Set<string> {
  return new Set(
    [...tagVariables(source)].filter(({ wholeLink }) => wholeLink).map(({ name }) => name),
  );
}

export function plainInPlaceDestination(body: string, names: ReadonlySet<string>): boolean {
  return (
    !!body &&
    body.trim() === body &&
    !/[[\]<>\r\n]/.test(body) &&
    !variableReferences(body).some(({ name }) => names.has(name))
  );
}

/** Shared authored-content guard, independent of the selected translation or render preset. */
export function globalsInPlaceSaveIssue(
  source: string,
  titleNames?: ReadonlySet<string>,
): string | undefined {
  if (!source.includes('import ') && (!titleNames?.size || !source.includes('export ')))
    return undefined;
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
): Definition | undefined {
  const english = entry.en;
  let selected = entry[language];
  if (
    language !== 'en' &&
    selected?.sourceUpdatedAt &&
    english?.updatedAt &&
    Date.parse(english.updatedAt) - Date.parse(selected.sourceUpdatedAt) > translationMaxAge
  )
    selected = undefined;
  return selected;
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

/** The legacy reader expands import lines before it removes block comments. */
export function protectCommentedGlobalImports(source: string): string {
  if (!source.includes('/*') || !source.includes('import ')) return source;
  const { comments } = markupCommentContext(source);
  return source.replace(
    /^import [A-z0-9 ]+? from (?:global|0*[123]) *$/gm,
    (line, offset: number) =>
      comments.some(({ from, to }) => from <= offset && offset < to) ? ` ${line}` : line,
  );
}

/** Resolve one selected language/part after number resolution, before lowering consumer markup. */
export function resolveGlobalsInPlace(
  source: string,
  language: Lang,
  { definitions, unavailable }: GlobalsInPlaceOptions,
): string {
  const requirePublished = (kind: Kind, name: string) => {
    if (unavailable?.[kind]?.has(name) && !Object.hasOwn(definitions[kind] ?? {}, name))
      throw new UnpublishedGlobal(kind, name);
  };
  const lookup = (kind: Kind, name: string, needed = true): string | undefined => {
    const entries = definitions[kind];
    if (!entries || !Object.hasOwn(entries, name)) return;
    const entry = entries[name];
    const selected = globalsInPlaceDefinition(entry, language);
    if (!selected && needed)
      throw new MissingGlobalTranslation(
        kind,
        name,
        language,
        entry[language] ? 'stale' : 'missing',
      );
    return selected?.body;
  };

  const active = new Set<string>();
  const expand = (text: string, authored: boolean): string =>
    protectCommentedGlobalImports(text).replace(
      /^import ([A-z0-9 ]+?) from global *$/gm,
      (_line, rawName: string) => {
        const name = rawName.trim();
        if (active.has(name)) throw new Error(`Remove the cycle in shared export ${name}.`);
        if (authored) requirePublished('exports', name);
        const body = lookup('exports', name);
        if (body === undefined) throw new Error(`Choose an existing shared export for ${name}.`);
        active.add(name);
        const expanded = expand(body, false);
        active.delete(name);
        return expanded;
      },
    );
  const variableUses = (text: string) => {
    const refs = variableReferences(text);
    if (!refs.length) return refs;
    const comments =
      text.includes('//') || text.includes('/*') ? markupCommentContext(text).comments : [];
    return refs.filter(
      ({ name, from }) =>
        name !== 'e' && !comments.some((span) => span.from <= from && from < span.to),
    );
  };
  const fill = (text: string): string => {
    let result = '';
    let at = 0;
    for (const { name, from, to } of variableUses(text)) {
      const body = lookup('variables', name)?.trim();
      if (body === undefined) continue;
      result += text.slice(at, from) + (body === 'empty' ? '' : body);
      at = to;
    }
    return at ? result + text.slice(at) : text;
  };

  // The pending catalogue governs this authored cell, including its direct imports.
  // Once published text is inserted, resolve it only against the published catalogue.
  if (unavailable?.variables?.size)
    for (const { name } of variableUses(source)) requirePublished('variables', name);
  const expanded = source.includes('import ') ? expand(source, true) : source;
  const text = fill(expanded);
  const names = new Set(Object.keys(definitions.titles ?? {}));
  if ((!names.size && !unavailable?.titles?.size) || !source) return text;
  const variables = Object.keys(definitions.variables ?? {}).flatMap((name) => {
    const body = lookup('variables', name, false);
    return name !== 'e' && body !== undefined ? [`var ${name} = ${body.trim() || 'empty'}`] : [];
  });
  const noteBlock = (name: string, body: string) => `title ${name} (\n${body}\n)`;
  const titles = [...names].flatMap((name) => {
    const body = lookup('titles', name, false);
    return body === undefined ? [] : [noteBlock(name, body)];
  });
  const globals = {
    variables: lowerConsumerMarkup([globalsInPlaceLibraryText(2), ...variables].join('\n')),
    titles: lowerConsumerMarkup(titles.join('\n')),
    lang: language,
  };
  const local = extractBlocks(text.replace(/\r/g, ''), 'title');
  if (unavailable?.titles?.size)
    for (const name of effectiveSharedNotes(
      lowerConsumerMarkup(source),
      { ...globals, variables: globalsInPlaceLibraryText(2)! },
      unavailable.titles,
    ))
      if (!Object.hasOwn(local, name)) requirePublished('titles', name);
  const reads = effectiveSharedNotes(lowerConsumerMarkup(expanded), globals, names);
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

export function withImportedGlobalsFallback(
  options: GlobalsInPlaceOptions,
  source: (hash: number) => { document: Tooltip; draft?: boolean } | undefined,
): GlobalsInPlaceOptions {
  const cache = new Map<
    number,
    { editor?: LegacyEntry['editor']; causes: Map<Lang, MissingGlobalTranslation> }
  >();
  const inspect = (hash: number) => {
    const cached = cache.get(hash);
    if (cached) return cached;
    const input = source(hash);
    const causes = new Map<Lang, MissingGlobalTranslation>();
    const row =
      input &&
      exportLegacy(
        [input.document],
        0,
        undefined,
        {},
        {
          globalsInPlace: input.draft ? options : { definitions: options.definitions },
          onGlobalsFallback: (_hash, cause) => causes.set(cause.language, cause),
        },
      )[input.document.hash];
    const inspected = { editor: row && !isLegacyAliasStub(row) ? row.editor : undefined, causes };
    cache.set(hash, inspected);
    return inspected;
  };
  const inherited = (
    text: string,
    lang: Lang,
    visited: Set<number>,
  ): MissingGlobalTranslation | undefined => {
    for (const line of markupImports(text)) {
      const target = / from (\d+) *$/.exec(line)?.[1];
      if (!target || visited.has(Number(target))) continue;
      const hash = Number(target);
      visited.add(hash);
      const { editor, causes } = inspect(hash);
      const local = editor?.[lang];
      const cause =
        causes.get(lang) ??
        (local && !local.englishFallback
          ? inherited(`${local.main}\n${local.secondary}`, lang, visited)
          : undefined);
      if (cause) return cause;
    }
  };
  return {
    ...options,
    importFallback: (text, lang) =>
      text.includes('import ') ? inherited(text, lang, new Set()) : undefined,
  };
}
