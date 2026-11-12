import { elementTextMarkers, markElementTags } from './elementTags.js';
import { markupStrayTags, parseLines } from './lines.js';
import { prepareMarkup, prepareNativeTitle, markupVariableReferences } from './prepare.js';
import type { MarkupDiagnostic, MarkupGlobals, MarkupLine, ParsedMarkup } from './types.js';

export type { MarkupGlobals, MarkupLine, MarkupSpan, ParsedMarkup } from './types.js';

const reservedMarker = /[\uE000\uE001]/;
export const reservedMarkerMessage =
  'Remove the private-use character U+E000 or U+E001: the preview reserves it for element-tagged text.';

export function parseMarkup(
  text: string,
  globals: MarkupGlobals = { variables: '', titles: '' },
): ParsedMarkup {
  const diagnostics: MarkupDiagnostic[] = [];
  // Element-tagged spans: every document this parse reads (the text, the global variables and
  // titles, each import it resolves) is lowered as consumers will receive it, with preview markers
  // around each tagged text, so the preview is exactly the lowered form plus the tint. A wrapper
  // that preparation assembles from pieces stays the bare icon, as consumers draw it.
  let reserved = false;
  const mark = (source: string) => {
    if (reservedMarker.test(source)) {
      reserved = true;
      source = source.replace(elementTextMarkers, '');
    }
    return markElementTags(source);
  };
  text = mark(text);
  globals = {
    ...globals,
    variables: mark(globals.variables),
    titles: mark(globals.titles),
    ...(globals.imports && {
      imports: new Proxy(globals.imports, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === 'string' ? mark(value) : value;
        },
      }),
    }),
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
    titles[name] = parseLines(body, {});
  }
  if (reserved) diagnostics.push({ severity: 'error', message: reservedMarkerMessage });
  return { lines: parseLines(prepared.text, titles), diagnostics };
}
