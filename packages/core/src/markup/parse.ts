import { markupStrayTags, parseLines } from './lines.js';
import { prepareMarkup, prepareNativeTitle, markupVariableReferences } from './prepare.js';
import type { MarkupDiagnostic, MarkupGlobals, MarkupLine, ParsedMarkup } from './types.js';

export function parseMarkup(
  text: string,
  globals: MarkupGlobals = { variables: '', titles: '' },
): ParsedMarkup {
  const diagnostics: MarkupDiagnostic[] = [];
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
