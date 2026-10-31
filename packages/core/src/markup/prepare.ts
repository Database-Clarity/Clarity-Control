import { evaluateMarkupMath } from './arithmetic.js';
import { extractBlocks, extractVariables } from './syntax.js';
import type { MarkupDiagnostic, MarkupGlobals } from './types.js';

/** The production comment semantics, shared by preparation and lossless conversion checks. */
export function removeMarkupComments(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\/\*[^]*\*\/\n?/g, '')
    .replace(/^ *?\/\/.*$\n?| +\/\/.*$/gm, '');
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
    const imports = [
      ...(text.match(/^import [A-z0-9 ]+? from (\d+|global) *?$/gm) ?? []),
      ...(text.match(/^import self *?$/gm) ?? []),
    ];
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
) {
  text = resolveImports(text, globals, diagnostics);
  const conditions = [
    ['enhanced', 'Weapon Trait Enhanced'],
    ['catalyst', 'Weapon Catalyst Exotic'],
    ['exotic perk', 'Weapon Perk Exotic'],
  ];
  for (const [keyword, type] of conditions) {
    const pattern = new RegExp(`^${keyword} \\([\\s\\S]*?\\n\\)$`, 'gm');
    if (pattern.test(text) && globals.type !== type) {
      text = text.replace(pattern, '');
      if (keyword === 'enhanced') text = text.replaceAll('#e', '');
    }
  }
  // Preserve the converter's one-pass, declaration-order expansion and global precedence.
  for (const variable of text.match(/#[a-zA-Z0-9]+/g) ?? []) {
    const variables = { ...extractVariables(text), ...extractVariables(globals.variables) };
    const value = variables[variable.slice(1)];
    if (value !== undefined) text = text.replaceAll(variable, value);
  }
  text = evaluateMarkupMath(text);
  const cleanText = removeUnusedText(text.trim());
  for (const variable of new Set(cleanText.match(/#[a-zA-Z0-9]+/g) ?? [])) {
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
