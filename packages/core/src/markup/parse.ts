import { elementTextMarkers, lowerElementTags, markElementTags } from './elementTags.js';
import { markupStrayTags, parseLines } from './lines.js';
import { prepareMarkup, prepareNativeTitle, markupVariableReferences } from './prepare.js';
import type {
  MarkupDiagnostic,
  MarkupGlobals,
  MarkupLine,
  MarkupSpan,
  ParsedMarkup,
} from './types.js';

export type { MarkupGlobals, MarkupLine, MarkupSpan, ParsedMarkup } from './types.js';

const reservedMarker = /[\uE000\uE001]/;
export const reservedMarkerMessage =
  'Remove the private-use character U+E000 or U+E001: the preview reserves it for element-tagged text.';

/**
 * Element-tagged spans. Every document a parse reads (the text, the global variables and titles,
 * each import it resolves) is lowered as consumers receive it. To tint the tagged text, the
 * parse first runs on the lowered documents with preview markers around each tagged text; when
 * any document held a tag, it also parses the plain lowered documents and keeps the tinted lines
 * only if, without the tint, they render exactly the same. Otherwise (markers changed how
 * preparation read the text, e.g. `<solar #hit />tail` lowers to the variable `#hittail`) the
 * plain lowered render is used. The preview is therefore always the lowered form, plus the tint
 * where it is safe; a wrapper that preparation assembles from pieces stays the bare icon.
 */
export function parseMarkup(
  text: string,
  globals: MarkupGlobals = { variables: '', titles: '' },
): ParsedMarkup {
  let reserved = false;
  let tagged = false;
  const clean = (source: string) => {
    if (!reservedMarker.test(source)) return source;
    reserved = true;
    return source.replace(elementTextMarkers, '');
  };
  const mark = (source: string) => {
    source = clean(source);
    const marked = markElementTags(source);
    if (marked !== source) tagged = true;
    return marked;
  };
  const tinted = parseWith(text, globals, mark);
  const parsed = tagged
    ? parseWith(text, globals, (source) => lowerElementTags(clean(source)))
    : tinted;
  const lines =
    tagged && JSON.stringify(untinted(tinted.lines)) === JSON.stringify(untinted(parsed.lines))
      ? tinted.lines
      : parsed.lines;
  const diagnostics = parsed.diagnostics;
  if (reserved) diagnostics.push({ severity: 'error', message: reservedMarkerMessage });
  return { lines, diagnostics };
}

/** The lines as drawn without the tint: tinted text joins its neighbouring plain text. */
function untinted(lines: readonly MarkupLine[]): unknown[] {
  const spans = (parts: readonly MarkupSpan[]) => {
    const out: MarkupSpan[] = [];
    for (const part of parts) {
      const span: MarkupSpan = part.classNames?.includes('elementText')
        ? { text: part.text }
        : part.title
          ? { ...part, title: untinted(part.title) as MarkupLine[] }
          : part;
      const last = out.at(-1);
      const plain = (value: MarkupSpan) =>
        value.text !== undefined && Object.keys(value).every((key) => key === 'text');
      if (last && plain(last) && plain(span))
        out[out.length - 1] = { text: last.text! + span.text! };
      else out.push(span);
    }
    return out;
  };
  return lines.map((line) => ({
    ...line,
    ...(line.linesContent && { linesContent: spans(line.linesContent) }),
    ...(line.table && {
      table: line.table.map((row) => ({
        ...row,
        rowContent: row.rowContent?.map((cell) => ({
          ...cell,
          cellContent: spans(cell.cellContent),
        })),
      })),
    }),
  }));
}

function parseWith(
  text: string,
  globals: MarkupGlobals,
  lower: (source: string) => string,
): ParsedMarkup {
  const diagnostics: MarkupDiagnostic[] = [];
  text = lower(text);
  globals = {
    ...globals,
    variables: lower(globals.variables),
    titles: lower(globals.titles),
    ...(globals.imports && {
      imports: new Proxy(globals.imports, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === 'string' ? lower(value) : value;
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
  return { lines: parseLines(prepared.text, titles), diagnostics };
}
