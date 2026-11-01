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

function spans(line: string, titles: Record<string, MarkupLine[]>): MarkupSpan[] {
  return line
    .split(new RegExp(`(${inlineToken.source}|🡅)`, 'g'))
    .filter(Boolean)
    .flatMap((text): MarkupSpan[] => {
      if (text === '🡅') return [{ text, classNames: ['enhancedArrow'] }];
      const wrapper = text.match(/<\w+/)?.[0].slice(1);
      if (wrapper === undefined) return [{ text }];
      if ([...markupColors, 'background', 'bold'].includes(wrapper)) {
        return [
          { text: text.replace(new RegExp(`<${wrapper} | />`, 'g'), ''), classNames: [wrapper] },
        ];
      }
      if ([...markupIcons, ...markupEmpty].includes(wrapper)) return [{ classNames: [wrapper] }];
      const target = text.match(/\[.+\]/)?.[0].replace(/\[|\]/g, '');
      const label = text.replace(/ \[.+\] \/>/g, '');
      if (!target || !label) return [];
      if (wrapper === 'link')
        return [{ text: label.replace('<link ', ''), link: target, classNames: ['link'] }];
      if (wrapper === 'title')
        return [
          { text: label.replace('<title ', ''), title: titles[target], classNames: ['title'] },
        ];
      // Stat formulas were intentionally removed in v2.
      return [];
    });
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
        cellContent: spans(cell.replace(/\|[bchr\d-]+|\|/, '').trim(), titles).flatMap((part) => {
          if (!part.text?.trim() && !part.classNames?.some((name) => typeof name === 'string'))
            return [];
          // Legacy tables omit link targets; preserve their output.
          return [{ text: part.text, classNames: part.classNames, title: part.title }];
        }),
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
        linesContent: spans(
          block.includes('<breakSpaces/>') ? cleanLine.trimEnd() : cleanLine.trim(),
          titles,
        ),
      },
    ];
  });
}
