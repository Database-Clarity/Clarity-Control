// Stage 5, symbol transforms (spec section 3 Compiler, section 6): turns the editor preview's
// resolved lines (core parseMarkup) into what one file holds, for the lines or the text shape.
// Only the file's own rules apply: a symbol the file does not name is dropped (its text kept)
// and reported, so a symbol added later never appears in an existing file until chosen.
import type { MarkupLine, MarkupSpan } from '@clarity/core/markup/parse';
import { elementTagNames } from '@clarity/core/markup/elementTags';
import type { FileFormat, SymbolRule } from './config.js';
import { iconSymbols, symbolIds, type Shape, type SymbolId } from './vocabulary.js';

/** One span of the resolved lines (internal; toLines writes format v1). Keys only when set. */
export type OutSpan = { text?: string; classNames?: string[]; link?: string; title?: OutLine[] };
/** One resolved line (internal; toLines writes format v1). */
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
  const rule = format.symbols[name] ?? (name === 'arrow' ? { mode: 'keep' as const } : undefined);
  if (!rule) notes.unchosen.add(name);
  return rule;
}

/** Class names once each, in order: the parser can list one twice (`<bold/>` is both a line
 * style and an empty marker), which must not apply a replacement twice. */
const unique = (names: readonly (string | undefined)[] | undefined): string[] => [
  ...new Set(
    (names ?? [])
      .filter((name): name is string => typeof name === 'string')
      .map((name) => (name === 'yellow' ? 'exotic' : name)),
  ),
];

type Context = { format: FileFormat; shape: Shape; notes: TransformNotes };

function span(input: MarkupSpan, context: Context): OutSpan[] {
  const { format, shape } = context;
  const text = input.text ?? '';
  const names = unique(input.classNames);
  // The element on tagged text names its tint, not another standalone icon. Only the
  // elementText rule transforms this span; keeping it also keeps its element metadata.
  const tint = names.includes('elementText')
    ? names.find((name) => (elementTagNames as readonly string[]).includes(name))
    : undefined;
  if (tint) names.splice(names.indexOf(tint), 1);
  // Resolve the standalone drawing before applying any surrounding text style.
  if (names.includes('arrow')) names.unshift(...names.splice(names.indexOf('arrow'), 1));
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
      // The title body follows the label in the same line, with the file's own rules: kept
      // symbols stay spans (lines shape), and its lines are joined with a space.
      const [before, after, innerBefore, innerAfter] = rule.pattern;
      const body = lines(input.title, context).flatMap((line, index) => [
        ...(index ? [{ text: ' ' }] : []),
        ...(line.linesContent ?? []).map((part) =>
          line.classNames
            ? { ...part, classNames: unique([...(part.classNames ?? []), ...line.classNames]) }
            : part,
        ),
      ]);
      return [{ text: `${before}${text}${after}${innerBefore}` }, ...body, { text: innerAfter }];
    }
    return [{ text }];
  }
  let out: OutSpan = input.text === undefined ? {} : { text };
  for (const name of names) {
    const rule =
      name === 'arrow' &&
      shape === 'text' &&
      (!format.symbols.arrow || format.symbols.arrow.mode === 'keep')
        ? { mode: 'replace' as const, before: '→', after: '' }
        : ruleFor(name, format, context.notes);
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
  if (tint && out.classNames?.includes('elementText')) out.classNames.push(tint);
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
    const names = unique(line.classNames);
    if (names.includes('spacer')) {
      if (context.format.spacer === 'keep') output.push({ classNames: ['spacer'] });
      continue;
    }
    let parts = line.linesContent ?? [];
    const arrowRule =
      context.format.symbols.arrow ??
      (context.shape === 'text'
        ? { mode: 'replace' as const, before: '→', after: '' }
        : { mode: 'keep' as const });
    if (arrowRule.mode !== 'keep' && parts.some((part) => part.classNames?.includes('arrow'))) {
      const joined: MarkupSpan[] = [];
      for (const input of parts) {
        const arrow = input.classNames?.includes('arrow');
        if (arrow && arrowRule.mode === 'drop') continue;
        const part = arrow
          ? {
              ...input,
              text: arrowRule.mode === 'replace' ? arrowRule.before + arrowRule.after : '',
              classNames: input.classNames?.filter((name) => name !== 'arrow'),
            }
          : input;
        const last = joined.at(-1);
        // Resolve the drawing's text before wrapping, so one bold run stays one Markdown pair.
        if (
          last &&
          last.text !== undefined &&
          part.text !== undefined &&
          !last.link &&
          !last.title &&
          !part.link &&
          !part.title &&
          JSON.stringify(last.classNames ?? []) === JSON.stringify(part.classNames ?? [])
        )
          joined[joined.length - 1] = { ...last, text: last.text + part.text };
        else joined.push(part);
      }
      parts = joined;
    }
    let content = parts.flatMap((part) => span(part, context));
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

/**
 * One part of a line in format v1 (spec section 7): an `icon` (the 16 icons, `arrow`, and
 * `enhancedArrow`, which keeps its glyph as `text`), or `text` with an optional `style` (bold,
 * exotic, pve, pvp), `element` (tagged element text), `link`, or `note` (the hover explanation).
 */
export type Part = {
  icon?: string;
  text?: string;
  style?: string[];
  element?: string;
  link?: string;
  note?: Line[];
};
/** One line of format v1: its parts and line-wide `style`, or a spacer. */
export type Line = { spacer: true } | { style?: string[]; parts: Part[] };

const iconNames = new Set<string>([...iconSymbols, 'arrow', 'enhancedArrow']);

function toPart(span: OutSpan): Part {
  const names = (span.classNames ?? []).filter((name) => name !== 'link' && name !== 'title');
  let element: string | undefined;
  if (names.includes('elementText')) {
    // span() above adds the tint as the last class name, after `elementText`.
    const last = names[names.length - 1]!;
    if ((elementTagNames as readonly string[]).includes(last)) element = names.pop();
    names.splice(names.indexOf('elementText'), 1);
  }
  const icon = names.find((name) => iconNames.has(name));
  const style = names.filter((name) => name !== icon);
  return {
    ...(icon ? { icon } : {}),
    ...(span.text !== undefined ? { text: span.text } : {}),
    ...(style.length ? { style } : {}),
    ...(element ? { element } : {}),
    ...(span.link !== undefined ? { link: span.link } : {}),
    ...(span.title ? { note: toLines(span.title) } : {}),
  };
}

/** The lines shape as format v1 writes it: `parts`, `style`, `icon`, `note`, and `spacer`. */
export function toLines(input: readonly OutLine[]): Line[] {
  return input.map((line) =>
    line.classNames?.[0] === 'spacer' && !line.linesContent
      ? { spacer: true }
      : {
          ...(line.classNames ? { style: line.classNames } : {}),
          parts: (line.linesContent ?? []).map(toPart),
        },
  );
}

/** Transforms one resolved description for a file. */
export function transform(
  input: readonly MarkupLine[],
  format: FileFormat,
  shape: Shape,
  notes: TransformNotes,
): Line[] | string {
  const output = lines(input, { format, shape, notes });
  return shape === 'lines' ? toLines(output) : renderText(output);
}
