import { evaluateMarkupMath } from './arithmetic.js';
import { extractBlocks, extractVariables } from './syntax.js';
import type { MarkupDiagnostic, MarkupGlobals } from './types.js';

/** Dependencies are recognised before comments are removed, exactly as production expands them. */
export function markupVariableReferences(text: string): string[] {
  return text.match(/#[a-zA-Z0-9]+/g) ?? [];
}

export function markupImports(text: string): string[] {
  return [
    ...(text.match(/^import [A-z0-9 ]+? from (\d+|global) *?$/gm) ?? []),
    ...(text.match(/^import self *?$/gm) ?? []),
  ];
}

export const markupConditions = [
  ['enhanced', 'Weapon Trait Enhanced'],
  ['catalyst', 'Weapon Catalyst Exotic'],
  ['exotic perk', 'Weapon Perk Exotic'],
] as const;

/** Shared recognition, including the production pre-comment boundary rules. */
export function markupConditionMatches(text: string, keyword: string): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(`^${keyword} \\([\\s\\S]*?\\n\\)$`, 'gm'))];
}

const markupCommentPatterns = [/\/\*[^]*\*\/\n?/g, /^ *?\/\/.*$\n?| +\/\/.*$/gm];

export function markupCommentContext(text: string): {
  text: string;
  offsets: number[];
  comments: { from: number; to: number }[];
} {
  let offsets = Array.from({ length: text.length }, (_, index) => index);
  const comments: { from: number; to: number }[] = [];
  for (const [index, pattern] of [/\r/g, ...markupCommentPatterns].entries()) {
    let remaining = '';
    let remainingOffsets: number[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      remaining += text.slice(last, match.index);
      remainingOffsets = remainingOffsets.concat(offsets.slice(last, match.index));
      if (index > 0) {
        comments.push({
          from: offsets[match.index],
          to: offsets[match.index + match[0].length - 1] + 1,
        });
      }
      last = match.index + match[0].length;
    }
    remaining += text.slice(last);
    remainingOffsets = remainingOffsets.concat(offsets.slice(last));
    text = remaining;
    offsets = remainingOffsets;
  }
  return { text, offsets, comments };
}

/** The production comment semantics, shared by preparation and lossless conversion checks. */
export function removeMarkupComments(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(markupCommentPatterns[0], '')
    .replace(markupCommentPatterns[1], '');
}

/** Production blank-line and boundary-whitespace normalisation; does not discard authored text. */
export function normalizeMarkupWhitespace(text: string): string {
  return text.replace(/\n\n\n+/gm, '\n\n').trim();
}

export function removeUnusedText(text: string, removeTitles = true): string {
  text = removeMarkupComments(text)
    .replace(/^export hidden .* \([^]*?\n\)$/gm, '')
    .replace(/^export .* \( *$\n/gm, '')
    .replace(/^enhanced \($\n/gm, '');
  if (removeTitles) {
    text = text.replace(/\n?^title .+ \([^]*?\n\)$/gm, '').replace(/\n^\) *$/gm, '');
  }
  return normalizeMarkupWhitespace(text.replace(/^var .* = .+$\n?/gm, ''));
}

function resolveImports(
  text: string,
  globals: MarkupGlobals,
  diagnostics: MarkupDiagnostic[],
): string {
  for (let pass = 0; pass < 5; pass++) {
    const imports = markupImports(text);
    if (!imports.length) return text;
    for (const line of imports) {
      const visible = removeUnusedText(text, false).includes(line.trim());
      if (line.includes('import self')) {
        if (visible)
          diagnostics.push({
            severity: 'error',
            message: 'import self requires the removed secondary editor.',
          });
        text = text.replace(line, '');
        continue;
      }
      const name = line.match(/(?<=import) .+ (?=from)/)?.[0].trim() ?? '';
      const from = line.match(/(?<=from) (\d+|global)/)?.[0].trim() ?? '';
      const source =
        globals.imports?.[from] ?? (from === 'global' ? globals.imports?.['1'] : undefined);
      const imported =
        name === 'main' || name === 'secondary'
          ? source
          : extractBlocks(source ?? '', 'export')[name];
      if (imported === undefined && visible) {
        diagnostics.push({
          severity: 'error',
          message: `Unresolved import "${name}" from ${from}.`,
        });
      }
      text = text.replace(line, () => imported ?? '');
    }
  }
  if (/^import /m.test(text)) {
    diagnostics.push({
      severity: 'error',
      message: 'Import expansion exceeded the converter limit of five passes (possible cycle).',
    });
  }
  return text;
}

export function prepareMarkup(
  text: string,
  globals: MarkupGlobals,
  diagnostics: MarkupDiagnostic[],
  onCondition?: (name: string, block: string) => void,
) {
  text = resolveImports(text, globals, diagnostics);
  for (const [keyword, type] of markupConditions) {
    const matches = markupConditionMatches(text, keyword);
    for (const match of matches) onCondition?.(keyword, match[0]);
    if (matches.length && globals.type !== type) {
      for (const match of matches.reverse())
        text = text.slice(0, match.index) + text.slice(match.index! + match[0].length);
      if (keyword === 'enhanced') text = text.replaceAll('#e', '');
    }
  }
  // Preserve the converter's one-pass, declaration-order expansion and global precedence.
  for (const variable of markupVariableReferences(text)) {
    const variables = { ...extractVariables(text), ...extractVariables(globals.variables) };
    globals.onVariable?.(variable.slice(1));
    const value = variables[variable.slice(1)];
    if (value !== undefined) text = text.replaceAll(variable, value);
  }
  text = evaluateMarkupMath(text);
  const cleanText = removeUnusedText(text.trim());
  for (const variable of new Set(markupVariableReferences(cleanText))) {
    diagnostics.push({ severity: 'warning', message: `Unknown variable ${variable}.` });
  }
  return {
    text: cleanText,
    titles: {
      ...extractBlocks(removeUnusedText(text, false), 'title'),
      ...extractBlocks(globals.titles, 'title'),
    },
  };
}
