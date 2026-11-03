import { markupStrayTags, parseLines } from './lines.js';
import { prepareMarkup } from './prepare.js';
import type { MarkupDiagnostic, MarkupGlobals, MarkupLine, ParsedMarkup } from './types.js';

export function parseMarkup(
  text: string,
  globals: MarkupGlobals = { variables: '', titles: '' },
): ParsedMarkup {
  const diagnostics: MarkupDiagnostic[] = [];
  const prepared = prepareMarkup(text, globals, diagnostics);
  for (const tag of new Set(markupStrayTags(prepared.text))) {
    diagnostics.push({
      severity: 'warning',
      message: `Unclosed or unknown tag "${tag}": text after it is read as markup and may be dropped or recoloured. Write a complete "${tag} text />" tag, or remove the "<".`,
    });
  }
  const titles: Record<string, MarkupLine[]> = {};
  for (const [name, content] of Object.entries(prepared.titles)) {
    titles[name] = parseLines(prepareMarkup(content, globals, diagnostics).text, {});
  }
  return { lines: parseLines(prepared.text, titles), diagnostics };
}
