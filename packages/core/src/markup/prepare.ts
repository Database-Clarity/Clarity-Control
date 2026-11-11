import { baseEnhancedMessage, enhancedMarkupType, scanBaseEnhanced } from './baseEnhanced.js';
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
  ['enhanced', enhancedMarkupType],
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

const unusedMarkup = {
  hidden: /^export hidden .* \([^]*?\n\)$/gm,
  exportOpen: /^export .* \( *$\n/gm,
  enhancedOpen: /^enhanced \($\n/gm,
  titles: /\n?^title .+ \([^]*?\n\)$/gm,
  close: /\n^\) *$/gm,
  variables: /^var .* = .+$\n?/gm,
  blanks: /\n\n\n+/gm,
};

/** Production blank-line and boundary-whitespace normalisation; does not discard authored text. */
export function normalizeMarkupWhitespace(text: string): string {
  return text.replace(unusedMarkup.blanks, '\n\n').trim();
}

export function removeUnusedText(text: string, removeTitles = true): string {
  text = removeMarkupComments(text)
    .replace(unusedMarkup.hidden, '')
    .replace(unusedMarkup.exportOpen, '')
    .replace(unusedMarkup.enhancedOpen, '');
  if (removeTitles) {
    text = text.replace(unusedMarkup.titles, '').replace(unusedMarkup.close, '');
  }
  return normalizeMarkupWhitespace(text.replace(unusedMarkup.variables, ''));
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

export type NativePiece = string | { base: string; enhanced: string; rendered?: string };
const pairSource = (piece: Exclude<NativePiece, string>) => `{{${piece.base}}{${piece.enhanced}}}`;
const pieceLength = (piece: NativePiece) =>
  typeof piece === 'string' ? piece.length : pairSource(piece).length;
const nativeSource = (pieces: readonly NativePiece[]) =>
  pieces.map((piece) => (typeof piece === 'string' ? piece : pairSource(piece))).join('');
const nativeStructure = (pieces: readonly NativePiece[]) =>
  pieces
    .map((piece) => (typeof piece === 'string' ? piece : '\uFFFC'.repeat(pieceLength(piece))))
    .join('');
const renderNative = (pieces: readonly NativePiece[]) =>
  pieces.map((piece) => (typeof piece === 'string' ? piece : piece.rendered!)).join('');

/** Native inline nodes stay opaque through variable, math, and title preparation. */
function nativePieces(text: string): NativePiece[] {
  if (!text.includes('{{')) return [text];
  const pieces: NativePiece[] = [];
  const visible = markupCommentContext(text);
  let at = 0;
  // Authored structure was validated before conditions; legacy #e removal may empty an arm.
  for (const pair of scanBaseEnhanced(visible.text, true).pairs) {
    const from = visible.offsets[pair.from],
      to = visible.offsets[pair.to - 1] + 1;
    pieces.push(text.slice(at, from), { base: pair.base, enhanced: pair.enhanced });
    at = to;
  }
  pieces.push(text.slice(at));
  return pieces;
}
function nativeSlice(pieces: readonly NativePiece[], from: number, to: number): NativePiece[] {
  const output: NativePiece[] = [];
  let at = 0;
  for (const piece of pieces) {
    const end = at + pieceLength(piece);
    if (end > from && at < to) {
      if (typeof piece === 'string')
        output.push(piece.slice(Math.max(0, from - at), Math.min(piece.length, to - at)));
      else {
        if (from > at || to < end)
          throw new Error('Structural cleanup crossed a native inline token');
        output.push(piece);
      }
    }
    at = end;
  }
  return output;
}
function nativeKeep(pieces: readonly NativePiece[], offsets: readonly number[]): NativePiece[] {
  const output: NativePiece[] = [];
  for (let index = 0; index < offsets.length;) {
    const from = offsets[index++];
    let to = from + 1;
    while (index < offsets.length && offsets[index] === to) {
      index++;
      to++;
    }
    output.push(...nativeSlice(pieces, from, to));
  }
  return output;
}
function nativeRemove(pieces: NativePiece[], pattern: RegExp, keepPrefix = 0): NativePiece[] {
  const output: NativePiece[] = [];
  const source = nativeStructure(pieces);
  let at = 0;
  for (const match of source.matchAll(pattern)) {
    output.push(...nativeSlice(pieces, at, match.index + keepPrefix));
    at = match.index + match[0].length;
  }
  output.push(...nativeSlice(pieces, at, source.length));
  return output;
}
function cleanNative(pieces: NativePiece[], removeTitles = true): NativePiece[] {
  // Use the same deletion grammar as removeUnusedText, on an AST structural view.
  // Masked node widths preserve ranges; their contents never become declarations or comments.
  pieces = nativeKeep(pieces, markupCommentContext(nativeStructure(pieces)).offsets);
  for (const pattern of [unusedMarkup.hidden, unusedMarkup.exportOpen, unusedMarkup.enhancedOpen])
    pieces = nativeRemove(pieces, pattern);
  if (removeTitles)
    for (const pattern of [unusedMarkup.titles, unusedMarkup.close])
      pieces = nativeRemove(pieces, pattern);
  pieces = nativeRemove(pieces, unusedMarkup.variables);
  pieces = nativeRemove(pieces, unusedMarkup.blanks, 2);
  const source = nativeStructure(pieces);
  return nativeSlice(pieces, source.length - source.trimStart().length, source.trimEnd().length);
}
function replaceNativeVariable(
  pieces: NativePiece[],
  variable: string,
  value: string,
): NativePiece[] {
  const output: NativePiece[] = [];
  const append = (piece: NativePiece) => {
    const last = output.length - 1;
    if (typeof piece === 'string' && typeof output[last] === 'string') output[last] += piece;
    else output.push(piece);
  };
  for (const piece of pieces) {
    if (typeof piece !== 'string' || !piece.includes(variable)) {
      append(piece);
      continue;
    }
    if (!value.includes('{{')) {
      append(piece.replaceAll(variable, value));
      continue;
    }
    piece.split(variable).forEach((part, index) => {
      if (index) nativePieces(value).forEach(append);
      append(part);
    });
  }
  return output;
}
function prepareNativePieces(pieces: NativePiece[], globals: MarkupGlobals): NativePiece[] {
  // References inside arms never drive surrounding legacy prefix replacement.
  const references = pieces.flatMap((piece) =>
    typeof piece === 'string' ? markupVariableReferences(piece) : [],
  );
  for (const variable of references) {
    const variables = {
      ...extractVariables(nativeSource(pieces)),
      ...extractVariables(globals.variables),
    };
    globals.onVariable?.(variable.slice(1));
    const value = Object.hasOwn(variables, variable.slice(1))
      ? variables[variable.slice(1)]
      : undefined;
    if (value !== undefined) pieces = replaceNativeVariable(pieces, variable, value);
  }
  const variables = {
    ...extractVariables(nativeSource(pieces)),
    ...extractVariables(globals.variables),
  };
  return pieces.map((piece) => {
    if (typeof piece === 'string') return evaluateMarkupMath(piece);
    if (piece.rendered !== undefined) return piece;
    let arm = globals.type === enhancedMarkupType ? piece.enhanced : piece.base;
    for (const variable of markupVariableReferences(arm)) {
      globals.onVariable?.(variable.slice(1));
      const value = Object.hasOwn(variables, variable.slice(1))
        ? variables[variable.slice(1)]
        : undefined;
      if (value !== undefined) arm = arm.replaceAll(variable, value);
    }
    return { ...piece, rendered: evaluateMarkupMath(arm) };
  });
}
export function prepareNativeTitle(pieces: NativePiece[], globals: MarkupGlobals): string {
  // Preserve legacy re-preparation for ordinary title text, while resolved nodes
  // stay opaque: a literal # or dollar boundary can never turn into a new lookup.
  return renderNative(cleanNative(prepareNativePieces(pieces, globals)));
}
function prepareNativeDocument(text: string, globals: MarkupGlobals) {
  const pieces = prepareNativePieces(nativePieces(text), globals);
  const titlePieces = cleanNative(pieces, false);
  const source = nativeStructure(titlePieces);
  const titles: Record<string, string> = Object.create(null);
  const nativeTitles: Record<string, NativePiece[]> = Object.create(null);
  const globalTitles = extractBlocks(globals.titles, 'title');
  for (const match of source.matchAll(/^title [A-z0-9 ]+ \([^]*?\n\)$/gm)) {
    const firstLine = match[0].indexOf('\n');
    const name = match[0]
      .slice(0, firstLine)
      .replace(/title|\(.*/gi, '')
      .trim();
    const body = nativeSlice(
      titlePieces,
      match.index + firstLine + 1,
      match.index + match[0].length - 2,
    );
    titles[name] = renderNative(body);
    if (!Object.hasOwn(globalTitles, name) && body.some((piece) => typeof piece !== 'string'))
      nativeTitles[name] = body;
  }
  return {
    text: renderNative(cleanNative(pieces)),
    titles: { ...titles, ...globalTitles },
    nativeTitles,
  };
}

export function prepareMarkup(
  text: string,
  globals: MarkupGlobals,
  diagnostics: MarkupDiagnostic[],
  onCondition?: (name: string, block: string) => void,
) {
  text = resolveImports(text, globals, diagnostics);
  const nativePairs =
    text.includes('{{') || globals.variables.includes('{{') || globals.titles.includes('{{');
  // Ordinary documents keep the existing preparation path. Native syntax is validated
  // before conditions or unused declarations can hide malformed structure.
  if (nativePairs) {
    for (const source of [text, globals.variables, globals.titles]) {
      if (source.includes('{{') && scanBaseEnhanced(removeMarkupComments(source)).issues.length) {
        diagnostics.push({ severity: 'error', message: baseEnhancedMessage });
      }
    }
  }
  for (const [keyword, type] of markupConditions) {
    const matches = markupConditionMatches(text, keyword);
    for (const match of matches) onCondition?.(keyword, match[0]);
    if (matches.length && globals.type !== type) {
      for (const match of matches.reverse())
        text = text.slice(0, match.index) + text.slice(match.index! + match[0].length);
      if (keyword === 'enhanced') text = text.replaceAll('#e', '');
    }
  }
  let native: ReturnType<typeof prepareNativeDocument> | undefined;
  if (nativePairs) {
    native = prepareNativeDocument(text, globals);
    text = native.text;
  } else {
    // The established converter path is unchanged for ordinary documents.
    for (const variable of markupVariableReferences(text)) {
      const variables = { ...extractVariables(text), ...extractVariables(globals.variables) };
      globals.onVariable?.(variable.slice(1));
      const value = variables[variable.slice(1)];
      if (value !== undefined) text = text.replaceAll(variable, value);
    }
    text = evaluateMarkupMath(text);
  }
  const cleanText = native ? text : removeUnusedText(text.trim());
  for (const variable of new Set(markupVariableReferences(cleanText))) {
    diagnostics.push({ severity: 'warning', message: `Unknown variable ${variable}.` });
  }
  return {
    text: cleanText,
    nativeTitles: native?.nativeTitles,
    titles: native?.titles ?? {
      ...extractBlocks(removeUnusedText(text, false), 'title'),
      ...extractBlocks(globals.titles, 'title'),
    },
  };
}
