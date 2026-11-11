// Stage 5, symbol transforms (spec section 3 Compiler, section 6): turns the editor preview's
// resolved lines (core parseMarkup) into what one file holds, for the lines or the text shape.
// Only the file's own rules apply: a symbol the file does not name is dropped (its text kept)
// and reported, so a symbol added later never appears in an existing file until chosen.
import type { MarkupLine, MarkupSpan } from '@clarity/core/markup/parse';
import type { FileFormat, SymbolRule } from './config.js';
import { symbolIds, type Shape, type SymbolId } from './vocabulary.js';

/** One span of the lines shape. Keys are only present when they carry something. */
export type OutSpan = { text?: string; classNames?: string[]; link?: string; title?: OutLine[] };
/** One line of the lines shape. */
export type OutLine = { classNames?: string[]; linesContent?: OutSpan[] };

/** What a transform noticed: symbols the file drops because it does not name them. */
export type TransformNotes = { unchosen: Set<string>; retired: Set<string>; tables: number };
export const emptyNotes = (): TransformNotes => ({
  unchosen: new Set(),
  retired: new Set(),
  tables: 0,
});

const isSymbol = (name: string): name is SymbolId =>
  (symbolIds as readonly string[]).includes(name);

/** The rule for a class name; undefined means drop it (unchosen or not a v1 symbol). */
function ruleFor(name: string, format: FileFormat, notes: TransformNotes): SymbolRule | undefined {
  if (!isSymbol(name)) {
    notes.retired.add(name);
    return undefined;
  }
  const rule = format.symbols[name];
  if (!rule) notes.unchosen.add(name);
  return rule;
}

type Context = { format: FileFormat; shape: Shape; notes: TransformNotes };

function span(input: MarkupSpan, context: Context): OutSpan[] {
  const { format, shape } = context;
  const text = input.text ?? '';
  const names = (input.classNames ?? []).filter((name): name is string => typeof name === 'string');
  if (names.includes('link') && input.link !== undefined) {
    const rule = format.links;
    if (rule.mode === 'keep' && shape === 'lines')
      return [{ text, link: input.link, classNames: ['link'] }];
    if (rule.mode === 'replace') {
      const [before, after, linkBefore, linkAfter] = rule.pattern;
      return [{ text: `${before}${text}${after}${linkBefore}${input.link}${linkAfter}` }];
    }
    return [{ text }];
  }
  if (names.includes('title')) {
    const rule = format.titles;
    if (rule.mode === 'keep' && shape === 'lines' && input.title) {
      const title = lines(input.title, context);
      return [title.length ? { text, title, classNames: ['title'] } : { text }];
    }
    if (rule.mode === 'inline' && input.title) {
      const [before, after, innerBefore, innerAfter] = rule.pattern;
      const body = renderText(lines(input.title, { ...context, shape: 'text' }), ' ');
      return [{ text: `${before}${text}${after}${innerBefore}${body}${innerAfter}` }];
    }
    return [{ text }];
  }
  let out: OutSpan = input.text === undefined ? {} : { text };
  for (const name of names) {
    const rule = ruleFor(name, format, context.notes);
    if (rule?.mode === 'keep' && shape === 'lines') {
      out = { ...out, classNames: [...(out.classNames ?? []), name] };
    } else if (rule?.mode === 'replace') {
      // The arrow's text is the glyph itself: replacing the arrow replaces the glyph.
      const inner = name === 'enhancedArrow' ? '' : (out.text ?? '');
      out = { ...out, text: `${rule.before}${inner}${rule.after}` };
    } else if (name === 'enhancedArrow') {
      // Dropping the arrow drops its glyph: the arrow is the whole text of its span.
      out = { ...out };
      delete out.text;
    }
  }
  return out.text === undefined && !out.classNames ? [] : [out];
}

/** Adjacent plain-text spans merge, empty ones go: the smallest equivalent line. */
function compact(spans: OutSpan[]): OutSpan[] {
  const output: OutSpan[] = [];
  for (const part of spans) {
    const plain = Object.keys(part).length === 1 && part.text !== undefined;
    if (plain && part.text === '') continue;
    const last = output[output.length - 1];
    if (plain && last && Object.keys(last).length === 1 && last.text !== undefined) {
      last.text += part.text;
    } else output.push(plain ? { text: part.text } : part);
  }
  return output;
}

export function lines(input: readonly MarkupLine[], context: Context): OutLine[] {
  const output: OutLine[] = [];
  for (const line of input) {
    if (line.table) {
      context.notes.tables++;
      continue;
    }
    const names = (line.classNames ?? []).filter(
      (name): name is string => typeof name === 'string',
    );
    if (names.includes('spacer')) {
      if (context.format.spacer === 'keep') output.push({ classNames: ['spacer'] });
      continue;
    }
    let content = (line.linesContent ?? []).flatMap((part) => span(part, context));
    const classNames: string[] = [];
    for (const name of names) {
      const rule = ruleFor(name, context.format, context.notes);
      if (rule?.mode === 'keep' && context.shape === 'lines') classNames.push(name);
      else if (rule?.mode === 'replace')
        content = [{ text: rule.before }, ...content, { text: rule.after }];
    }
    content = compact(content);
    if (!content.length) continue;
    output.push(
      classNames.length ? { classNames, linesContent: content } : { linesContent: content },
    );
  }
  // Spacers only separate lines: none at the start or the end.
  const isSpacer = (line: OutLine | undefined) =>
    line?.classNames?.[0] === 'spacer' && !line.linesContent;
  while (isSpacer(output[0])) output.shift();
  while (isSpacer(output[output.length - 1])) output.pop();
  return output;
}

/** The text shape: one string, lines joined by `separator` (a spacer is an empty line). */
export function renderText(input: readonly OutLine[], separator = '\n'): string {
  return input
    .map((line) => (line.linesContent ?? []).map((part) => part.text ?? '').join(''))
    .join(separator)
    .trim();
}

/** Transforms one resolved description for a file. */
export function transform(
  input: readonly MarkupLine[],
  format: FileFormat,
  shape: Shape,
  notes: TransformNotes,
): OutLine[] | string {
  const output = lines(input, { format, shape, notes });
  return shape === 'lines' ? output : renderText(output);
}
