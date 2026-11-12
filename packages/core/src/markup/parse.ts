import { findElementTags } from './elementTags.js';
import { markupStrayTags, parseLines, type LiteralElementTag } from './lines.js';
import { prepareMarkup, prepareNativeTitle, markupVariableReferences } from './prepare.js';
import type { MarkupDiagnostic, MarkupGlobals, MarkupLine, ParsedMarkup } from './types.js';

export type { MarkupGlobals, MarkupLine, MarkupSpan, ParsedMarkup } from './types.js';

export function parseMarkup(
  text: string,
  globals: MarkupGlobals = { variables: '', titles: '' },
): ParsedMarkup {
  const diagnostics: MarkupDiagnostic[] = [];
  // Element-tagged spans are lowered per source document, so only a token written as such in a
  // document this parse reads (the text, the global variables and titles, imported documents)
  // renders tagged; one assembled by preparation keeps today's meaning, as consumers read it.
  const sources = [text, globals.variables, globals.titles];
  if (globals.imports) {
    const catalog = globals.imports;
    globals = {
      ...globals,
      imports: new Proxy(catalog, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value === 'string') sources.push(value);
          return value;
        },
      }),
    };
  }
  let literal: { read: number; tokens: Set<string> } | undefined;
  const literalTag: LiteralElementTag = (token) => {
    if (literal?.read !== sources.length) {
      literal = {
        read: sources.length,
        tokens: new Set(
          sources.flatMap((source) =>
            findElementTags(source).map(({ from, to }) => source.slice(from, to)),
          ),
        ),
      };
    }
    return literal.tokens.has(token);
  };
  const prepared = prepareMarkup(text, globals, diagnostics);
  const titleBodies = prepared.nativeTitles
    ? Object.entries(prepared.titles).map(([name, content]) =>
        prepared.nativeTitles![name]
          ? prepareNativeTitle(prepared.nativeTitles![name], globals)
          : prepareMarkup(content, globals, []).text,
      )
    : Object.values(prepared.titles).map((content) => prepareMarkup(content, globals, []).text);
  for (const tag of new Set([prepared.text, ...titleBodies].flatMap(markupStrayTags))) {
    diagnostics.push({
      severity: 'warning',
      message: `Unclosed or unknown tag "${tag}": text after it is read as markup and may be dropped or recoloured. Write a complete "${tag} text />" tag, or remove the "<".`,
    });
  }
  const titles: Record<string, MarkupLine[]> = {};
  for (const [name, content] of Object.entries(prepared.titles)) {
    const native = prepared.nativeTitles?.[name];
    // Surrounding title text keeps legacy preparation; native nodes stay opaque.
    const body = native
      ? prepareNativeTitle(native, globals)
      : prepareMarkup(content, globals, diagnostics).text;
    if (native) {
      for (const variable of new Set(markupVariableReferences(body))) {
        diagnostics.push({ severity: 'warning', message: `Unknown variable ${variable}.` });
      }
    }
    titles[name] = parseLines(body, {}, literalTag);
  }
  return { lines: parseLines(prepared.text, titles, literalTag), diagnostics };
}
