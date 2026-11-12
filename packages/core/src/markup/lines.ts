import {
  elementTagNames,
  elementTextClose,
  elementTextMarkers,
  elementTextOpen,
} from './elementTags.js';
import {
  markupColors,
  markupEmpty,
  markupIcons,
  markupLineClasses,
  markupTableClasses,
} from './syntax.js';
import type { MarkupLine, MarkupSpan } from './types.js';
import { weaponSectionHeadings } from './weaponHeadings.js';

const inlineToken = /<.+?\/>/;

function lineClasses(line: string, allowed: string[], offsets?: number[]) {
  const classNames = allowed.filter((name) => line.includes(`<${name}/>`));
  let cleanLine = line;
  for (const name of classNames) {
    const marker = `<${name}/>`;
    const index = cleanLine.indexOf(marker);
    if (index !== -1) {
      cleanLine = cleanLine.slice(0, index) + cleanLine.slice(index + marker.length);
      offsets?.splice(index, marker.length);
    }
  }
  return {
    classNames,
    cleanLine,
  };
}

export function markupInlineRanges(line: string): { from: number; to: number }[] {
  return [markupLineClasses, markupEmpty, []].flatMap((allowed) => {
    const offsets = Array.from({ length: line.length }, (_, index) => index);
    const { cleanLine } = lineClasses(line, allowed, offsets);
    return [...cleanLine.matchAll(new RegExp(inlineToken, 'g'))].map((match) => ({
      from: offsets[match.index],
      to: offsets[match.index + match[0].length - 1] + 1,
    }));
  });
}

/**
 * Text outside a complete `<tag ... />` token that still starts with `<word` is treated as a
 * wrapper by the converter (and by consumers), which can drop or recolour the text. Report it
 * instead of changing the output.
 */
export function markupStrayTags(text: string): string[] {
  const stray: string[] = [];
  for (const line of weaponSectionHeadings(text).split('\n')) {
    if (line.startsWith('< table ') || line.startsWith('<$>')) continue;
    for (const segment of line.split(new RegExp(`(${inlineToken.source})`, 'g'))) {
      const tags = segment.match(/<\w+/g) ?? [];
      // A complete token holds one tag; a second `<word` inside it means a missing `/>`.
      const isToken = new RegExp(`^${inlineToken.source}$`).test(segment);
      if (tags.length > (isToken ? 1 : 0)) stray.push(tags[0]!);
    }
  }
  return stray;
}

const elements: ReadonlySet<string> = new Set(elementTagNames);
const markedPart = new RegExp(`(${inlineToken.source}|🡅|[\uE000\uE001])`, 'g');

/** trim() / trimEnd() that also pass over the preview markers at the ends (they are not text). */
function trimMarked(text: string, start = true): string {
  if (!text.includes(elementTextOpen) && !text.includes(elementTextClose))
    return start ? text.trim() : text.trimEnd();
  const end = /[\s\uE000\uE001]*$/.exec(text)![0];
  text = text.slice(0, text.length - end.length) + end.replace(/\s/g, '');
  if (!start) return text;
  const lead = /^[\s\uE000\uE001]*/.exec(text)![0];
  return lead.replace(/\s/g, '') + text.slice(lead.length);
}

/**
 * The spans of one line. Element-tagged text arrives lowered (parseMarkup): the icon, then its
 * text between preview markers, which tint that text and are dropped, so the result is exactly
 * the lowered form's spans with the tagged text as its own tinted span.
 */
function spans(line: string, titles: Record<string, MarkupLine[]>): MarkupSpan[] {
  let tint: string | undefined;
  const out: MarkupSpan[] = [];
  for (const part of line.split(markedPart)) {
    if (!part) continue;
    if (part === elementTextOpen) {
      // The lowered icon before the text (past its leading spaces) names the element.
      let at = out.length - 1;
      while (at >= 0 && !out[at].classNames && !out[at].text?.trim()) at--;
      const icon = out[at];
      const element = icon && icon.text === undefined ? icon.classNames?.[0] : undefined;
      tint = element && elements.has(element) ? element : undefined;
      continue;
    }
    if (part === elementTextClose) {
      tint = undefined;
      continue;
    }
    const text = part.replace(elementTextMarkers, '');
    if (!text) continue;
    for (const span of lineSpans(text, titles))
      out.push(
        tint && span.text !== undefined && !span.classNames
          ? { text: span.text, classNames: ['elementText', tint] }
          : span,
      );
  }
  return out;
}

/** One token or plain-text part, as before element tags. */
function lineSpans(text: string, titles: Record<string, MarkupLine[]>): MarkupSpan[] {
  if (text === '🡅') return [{ text, classNames: ['enhancedArrow'] }];
  const wrapper = text.match(/<\w+/)?.[0].slice(1);
  if (wrapper === undefined) return [{ text }];
  if ([...markupColors, 'background', 'bold'].includes(wrapper)) {
    return [{ text: text.replace(new RegExp(`<${wrapper} | />`, 'g'), ''), classNames: [wrapper] }];
  }
  if ([...markupIcons, ...markupEmpty].includes(wrapper)) return [{ classNames: [wrapper] }];
  const target = text.match(/\[.+\]/)?.[0].replace(/\[|\]/g, '');
  const label = text.replace(/ \[.+\] \/>/g, '');
  if (!target || !label) return [];
  if (wrapper === 'link')
    return [{ text: label.replace('<link ', ''), link: target, classNames: ['link'] }];
  if (wrapper === 'title')
    return [{ text: label.replace('<title ', ''), title: titles[target], classNames: ['title'] }];
  // Stat formulas were intentionally removed in v2.
  return [];
}

function tableRow(line: string, titles: Record<string, MarkupLine[]>) {
  const { classNames, cleanLine } = lineClasses(line, markupEmpty);
  return {
    classNames,
    rowContent: (cleanLine.match(/\|.*?((?=\|)|$)/g) ?? []).map((cell) => {
      const span = cell.match(/\|([bchr\d-]+)?/)?.[0].match(/-\d|\d/g);
      const colSpan = span?.filter((value) => Number(value) > 0)[0];
      const rowSpan = span?.filter((value) => Number(value) < 0)[0];
      const classes: Record<string, string> = {
        b: 'bold',
        c: 'center',
        h: 'background',
        r: 'right',
      };
      return {
        colSpan: colSpan ? Number(colSpan) : undefined,
        rowSpan: rowSpan ? -Number(rowSpan) : undefined,
        classNames: cell
          .match(/\|[bchr\d-]+/)?.[0]
          .split('')
          .filter((char) => classes[char])
          .map((char) => classes[char]),
        cellContent: spans(trimMarked(cell.replace(/\|[bchr\d-]+|\|/, '')), titles).flatMap(
          (part) => {
            if (!part.text?.trim() && !part.classNames?.some((name) => typeof name === 'string'))
              return [];
            // Legacy tables omit link targets; preserve their output.
            return [{ text: part.text, classNames: part.classNames, title: part.title }];
          },
        ),
      };
    }),
  };
}

export function parseLines(text: string, titles: Record<string, MarkupLine[]>): MarkupLine[] {
  const blocks = weaponSectionHeadings(text).match(/(< table [^]+?\n<\$>\n?)|(.+\n?|\n)/g) ?? [];
  return blocks.flatMap((block): MarkupLine[] => {
    block = block.trimEnd();
    if (block.startsWith('< table ')) {
      const rows = block.split('\n');
      if (rows.length < 3) return [];
      const names = rows[0]
        .replace(/< table | >/g, '')
        .match(/(\w+)/g)
        ?.filter((name) => markupTableClasses.includes(name));
      return [
        {
          table: rows.slice(1, -1).map((row) => tableRow(row, titles)),
          classNames: [...(names ?? []), 'table'],
          isFormula: names?.includes('formula'),
        },
      ];
    }
    if (!block.trim()) return [{ classNames: ['spacer'] }];
    const { classNames, cleanLine } = lineClasses(block, markupLineClasses);
    return [
      {
        classNames,
        linesContent: spans(trimMarked(cleanLine, !block.includes('<breakSpaces/>')), titles),
      },
    ];
  });
}
