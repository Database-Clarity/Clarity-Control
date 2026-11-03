import {
  markupCommentContext,
  resolveAlias,
  type Aliases,
  type Lang,
  type MarkupGlobals,
  type Tooltip,
} from '@clarity/core';

/**
 * Pure resolution of the references an author can hover or jump from: `#variables`, `[titles]`
 * and `import … from …`. Nothing here touches CodeMirror, so it is cheap to test and is only
 * ever called lazily (on hover, F12 or Ctrl+Click), never while typing.
 */

export type ReferenceKind = 'variable' | 'title' | 'import';

/** A reference token on one line; offsets are relative to that line. */
export interface LineReference {
  kind: ReferenceKind;
  name: string;
  /** `import … from <source>`: the tooltip hash or `global`. */
  source?: string;
  from: number;
  to: number;
}

export const variablesHash = 2;
export const titlesHash = 3;
const globalImportsHash = 1;

const importLine = /^import ([A-z0-9 ]+?) from (\d+|global) *$/;
const titleReference = /<title .+? \[([^\]]+)\] \/>/g;

/** The reference under `column` (inclusive of both token edges), or null. */
export function referenceInLine(line: string, column: number): LineReference | null {
  const imported = importLine.exec(line);
  if (imported) {
    const from = 'import '.length;
    const to = line.trimEnd().length;
    return column >= from && column <= to && imported[1].trim() !== 'self'
      ? { kind: 'import', name: imported[1].trim(), source: imported[2], from, to }
      : null;
  }
  for (const match of line.matchAll(/#([a-zA-Z0-9]+)/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (column >= from && column <= to) return { kind: 'variable', name: match[1], from, to };
  }
  for (const match of line.matchAll(titleReference)) {
    const to = match.index + match[0].length - '] />'.length;
    const from = to - match[1].length;
    if (column >= from && column <= to) return { kind: 'title', name: match[1], from, to };
  }
  return null;
}

let commentCache: { text: string; ranges: { from: number; to: number }[] } | undefined;
/** Comments are never references; the parser ignores them too. */
export function isInComment(text: string, from: number, to: number): boolean {
  if (!text.includes('//') && !text.includes('/*')) return false;
  if (commentCache?.text !== text) {
    commentCache = { text, ranges: markupCommentContext(text).comments };
  }
  return commentCache.ranges.some((range) => from >= range.from && to <= range.to);
}

/** A definition found in some text. `from`/`to` select the name; `line` is 1-based. */
export interface Located {
  name: string;
  /** Variable value, or the text between a block's parentheses. */
  value: string;
  /** The definition exactly as authored, so it can be fed back to the parser. */
  raw: string;
  line: number;
  from: number;
  to: number;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset;) {
    line++;
    index = text.indexOf('\n', index + 1);
  }
  return line;
}

/** `var name = value`, last definition winning, exactly like `extractVariables`. */
export function locateVariables(text: string): Map<string, Located> {
  const found = new Map<string, Located>();
  for (const match of text.matchAll(/^var ([a-zA-Z0-9]+) = (.+)$/gm)) {
    const value = match[2].trim();
    found.set(match[1], {
      name: match[1],
      value: value === 'empty' ? '' : value,
      raw: match[0].replace(/\r$/, ''),
      line: lineOf(text, match.index),
      from: match.index + 'var '.length,
      to: match.index + 'var '.length + match[1].length,
    });
  }
  return found;
}

/** `title Name (…)` / `export [hidden] Name (…)` blocks, keyed exactly like `extractBlocks`. */
export function locateBlocks(text: string, kind: 'title' | 'export'): Map<string, Located> {
  const pattern =
    kind === 'title' ? /^title [A-z0-9 ]+ \([^]*?\n\)$/gm : /^export [A-z0-9 ]+ \([\s\S]*?\n\)$/gm;
  const found = new Map<string, Located>();
  for (const match of text.matchAll(pattern)) {
    const lines = match[0].split('\n');
    const name = lines[0]
      .replace(kind === 'title' ? /title|\(.*/gi : /export|hidden|\(.*/gi, '')
      .trim();
    const prefix =
      lines[0].match(kind === 'title' ? /^title +/ : /^export(?: hidden)? +/)?.[0] ?? '';
    const header = lines[0].slice(prefix.length).replace(/ *\(.*$/, '');
    found.set(name, {
      name,
      value: lines.slice(1, -1).join('\n'),
      raw: match[0].replace(/\r/g, ''),
      line: lineOf(text, match.index),
      from: match.index + prefix.length,
      to: match.index + prefix.length + header.length,
    });
  }
  return found;
}

/** Where authored tooltip text lives; `hash` is canonical, so aliases land on the right page. */
export interface ReferenceSources {
  textFor(hash: number, lang: Lang): { hash: number; text: string } | undefined;
}

/** Authored text of any tooltip in any language (drafts win), following aliases. */
export function tooltipTextSources(
  tooltips: Readonly<Record<string, Tooltip>>,
  drafts: Readonly<Record<string, { next: Tooltip }>>,
  aliases: Aliases,
): ReferenceSources {
  return {
    textFor(hash, lang) {
      const canonical = resolveAlias(hash, aliases);
      const text = (drafts[canonical]?.next ?? tooltips[canonical])?.text[lang]?.text;
      return text === undefined ? undefined : { hash: canonical, text };
    },
  };
}

/** Fallback when the host has no tooltip store: only the already-merged globals of one language. */
export function sourcesFromGlobals(globals: MarkupGlobals, lang: Lang): ReferenceSources {
  return {
    textFor(hash, requested) {
      if (requested !== lang) return undefined;
      const text =
        hash === variablesHash
          ? globals.variables
          : hash === titlesHash
            ? globals.titles
            : globals.imports?.[String(hash)];
      return text === undefined ? undefined : { hash, text };
    },
  };
}

export type ReferenceTarget =
  | { type: 'local'; from: number; to: number }
  | { type: 'tooltip'; hash: number; lang: Lang; line: number };

export interface ResolvedReference {
  kind: ReferenceKind;
  name: string;
  /** What the reference is written as, e.g. `#damage`, `[Details]`, `import Perk from 42`. */
  label: string;
  status: 'found' | 'missing';
  scope?: 'local' | 'global' | 'import';
  /** The definition's text; `''` is an `empty` variable. */
  value?: string;
  /** Language of `value`. */
  lang?: Lang;
  /** `value` is English because the current language has no definition. */
  fallback?: boolean;
  /** Tooltip the definition lives in (global scope and imports). */
  hash?: number;
  /** `main` / `secondary` imports pull the whole text. */
  whole?: boolean;
  note?: string;
  /** Why nothing was found. */
  reason?: string;
  target?: ReferenceTarget;
}

export interface ResolveContext {
  /** The whole editor document. */
  doc: string;
  lang: Lang;
  globals: MarkupGlobals;
  sources: ReferenceSources;
  /** Hash of the tooltip being edited, so definitions in the open document are not "navigated" to. */
  selfHash?: number;
}

function labelFor(ref: Pick<LineReference, 'kind' | 'name' | 'source'>): string {
  return ref.kind === 'variable'
    ? `#${ref.name}`
    : ref.kind === 'title'
      ? `[${ref.name}]`
      : `import ${ref.name} from ${ref.source}`;
}

function tooltipTarget(
  context: ResolveContext,
  hash: number,
  lang: Lang,
  find: (text: string) => Located | undefined,
): ReferenceTarget | undefined {
  if (hash === context.selfHash && lang === context.lang) {
    const own = find(context.doc);
    if (own) return { type: 'local', from: own.from, to: own.to };
  }
  const located = find(context.sources.textFor(hash, lang)?.text ?? '');
  return located ? { type: 'tooltip', hash, lang, line: located.line } : undefined;
}

function resolveGlobalDefinition(ref: LineReference, context: ResolveContext): ResolvedReference {
  const isVariable = ref.kind === 'variable';
  const hash = isVariable ? variablesHash : titlesHash;
  const locate = (text: string) =>
    (isVariable ? locateVariables(text) : locateBlocks(text, 'title')).get(ref.name);
  const base = { kind: ref.kind, name: ref.name, label: labelFor(ref) } as const;
  const global = locate(isVariable ? context.globals.variables : context.globals.titles);
  const local = locate(context.doc);
  // The parser merges `{ ...local, ...globals }`, so a global would silently win; validation
  // reports a local definition of a global name as an error, and the note says the same.
  if (global) {
    return {
      ...base,
      status: 'found',
      scope: 'global',
      value: global.value,
      lang: context.lang,
      hash,
      note:
        local && context.selfHash !== hash
          ? `Error: also defined in this tooltip. The global is the one used; rename the local ${
              isVariable ? 'variable' : 'title'
            } before saving.`
          : undefined,
      target: tooltipTarget(context, hash, context.lang, locate),
    };
  }
  if (local) {
    return {
      ...base,
      status: 'found',
      scope: 'local',
      value: local.value,
      lang: context.lang,
      target: { type: 'local', from: local.from, to: local.to },
    };
  }
  const english = context.lang === 'en' ? undefined : context.sources.textFor(hash, 'en')?.text;
  const fallback = english === undefined ? undefined : locate(english);
  if (fallback) {
    return {
      ...base,
      status: 'found',
      scope: 'global',
      value: fallback.value,
      lang: 'en',
      fallback: true,
      hash,
      note: 'Not defined in this language yet; the preview will flag it until it is added.',
      target: tooltipTarget(context, hash, 'en', locate),
    };
  }
  return {
    ...base,
    status: 'missing',
    reason: `No ${isVariable ? 'variable' : 'title'} "${ref.name}" in this tooltip or in ${
      isVariable ? 'Variables' : 'Titles'
    } (${hash}).`,
  };
}

function resolveImport(ref: LineReference, context: ResolveContext): ResolvedReference {
  const source = ref.source ?? '';
  const hash = source === 'global' ? globalImportsHash : Number(source);
  const base = { kind: ref.kind, name: ref.name, label: labelFor(ref), scope: 'import' } as const;
  const whole = ref.name === 'main' || ref.name === 'secondary';
  const locate = (text: string): Located | undefined =>
    whole
      ? text
        ? { name: ref.name, value: text, raw: text, line: 1, from: 0, to: 0 }
        : undefined
      : locateBlocks(text, 'export').get(ref.name);
  // Same lookup the parser performs: the merged imports first, then the tooltip store.
  const own = context.globals.imports?.[source === 'global' ? '1' : source];
  const current = context.sources.textFor(hash, context.lang);
  const text = own ?? current?.text;
  const resolvedHash = current?.hash ?? hash;
  const found = text === undefined ? undefined : locate(text);
  if (found) {
    return {
      ...base,
      status: 'found',
      value: found.value,
      lang: context.lang,
      hash: resolvedHash,
      whole,
      target: tooltipTarget(context, resolvedHash, context.lang, locate),
    };
  }
  const english = context.lang === 'en' ? undefined : context.sources.textFor(hash, 'en');
  const fallback = english === undefined ? undefined : locate(english.text);
  if (fallback && english) {
    return {
      ...base,
      status: 'found',
      value: fallback.value,
      lang: 'en',
      fallback: true,
      hash: english.hash,
      whole,
      note: 'Not available in this language yet; the preview will flag it until it is added.',
      target: tooltipTarget(context, english.hash, 'en', locate),
    };
  }
  return {
    ...base,
    status: 'missing',
    hash: resolvedHash,
    reason: whole
      ? `Tooltip ${source} has no text to import.`
      : text === undefined
        ? `Tooltip ${source} has no text.`
        : `Tooltip ${source} has no export "${ref.name}".`,
  };
}

export function resolveReference(ref: LineReference, context: ResolveContext): ResolvedReference {
  return ref.kind === 'import'
    ? resolveImport(ref, context)
    : resolveGlobalDefinition(ref, context);
}

/** Definitions in the open document, so snippets can expand nested `#vars` and `[titles]`. */
export function localDefinitions(doc: string): { variables: string; titles: string } {
  return {
    variables: [...locateVariables(doc).values()]
      .map((variable) => (variable.value === '' ? `var ${variable.name} = empty` : variable.raw))
      .join('\n'),
    titles: [...locateBlocks(doc, 'title').values()].map((block) => block.raw).join('\n'),
  };
}
