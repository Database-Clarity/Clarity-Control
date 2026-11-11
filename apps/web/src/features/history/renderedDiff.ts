import { parseMarkup, type MarkupGlobals, type MarkupLine, type MarkupSpan } from '@clarity/core';
import { diffWords } from '../../ui/diff/diffWords';

export interface DiffSpan extends MarkupSpan {
  diffKind?: 'insert' | 'delete';
}

/** Source ranges remain visible even when comments, variables, or equivalent tags render alike. */
export function changedSourceLines(before: string, after: string): string | undefined {
  if (before === after) return;
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const range = (end: number) =>
    end <= start
      ? `after line ${start}`
      : end === start + 1
        ? `line ${end}`
        : `lines ${start + 1}–${end}`;
  return `Source changed: previous ${range(endA)}; current ${range(endB)}. Raw shows markup edits.`;
}

/** Compare render data, never fragments of source markup (tags may span words or lines). */
export function renderedDiff(
  before: string,
  after: string,
  globals: MarkupGlobals,
  precise = true,
) {
  if (!precise) {
    const coarse = (text: string, diffKind: DiffSpan['diffKind']) => {
      const lines = parseMarkup(text, globals).lines;
      for (const line of lines) {
        for (const span of line.linesContent ?? []) (span as DiffSpan).diffKind = diffKind;
        for (const row of line.table ?? [])
          for (const cell of row.rowContent ?? [])
            for (const span of cell.cellContent) (span as DiffSpan).diffKind = diffKind;
      }
      return lines;
    };
    return {
      before: coarse(before, before === after ? undefined : 'delete'),
      after: coarse(after, before === after ? undefined : 'insert'),
    };
  }
  function side(text: string) {
    const keys: string[] = [];
    const spans: DiffSpan[] = [];
    const split = (parts: MarkupSpan[], context: unknown): DiffSpan[] =>
      parts.flatMap((part) => {
        const words =
          part.link || part.title || part.text === undefined
            ? [part.text]
            : (part.text.match(/\s+|[^\s]+/g) ?? []);
        return words.map((text) => {
          const span = { ...part, text };
          spans.push(span);
          // One whitespace-free diff token per rendered word, icon, link, or title.
          keys.push(encodeURIComponent(JSON.stringify([span, context])));
          return span;
        });
      });
    const lines: MarkupLine[] = parseMarkup(text, globals).lines.map((line) => ({
      ...line,
      linesContent: line.linesContent && split(line.linesContent, line.classNames),
      table: line.table?.map((row) => ({
        ...row,
        rowContent: row.rowContent?.map((cell) => ({
          ...cell,
          cellContent: split(cell.cellContent, [
            line.classNames,
            row.classNames,
            cell.classNames,
            cell.colSpan,
            cell.rowSpan,
          ]),
        })),
      })),
    }));
    return { lines, spans, keys: keys.join(' ') };
  }
  const left = side(before),
    right = side(after);
  let a = 0,
    b = 0;
  for (const part of diffWords(left.keys, right.keys)) {
    const count = part.text.split(/\s+/).filter(Boolean).length;
    for (let i = 0; i < count; i++) {
      if (part.kind !== 'insert') {
        if (part.kind === 'delete') left.spans[a].diffKind = 'delete';
        a++;
      }
      if (part.kind !== 'delete') {
        if (part.kind === 'insert') right.spans[b].diffKind = 'insert';
        b++;
      }
    }
  }
  // Restore contiguous runs so unchanged paragraphs retain the preview's small DOM.
  function compact(parts: DiffSpan[]): DiffSpan[] {
    const result: DiffSpan[] = [];
    for (const part of parts) {
      const last = result.at(-1);
      if (
        last &&
        last.text !== undefined &&
        part.text !== undefined &&
        !last.link &&
        !part.link &&
        !last.title &&
        !part.title &&
        last.diffKind === part.diffKind &&
        JSON.stringify(last.classNames) === JSON.stringify(part.classNames)
      )
        last.text += part.text;
      else result.push({ ...part });
    }
    return result;
  }
  for (const line of [...left.lines, ...right.lines]) {
    if (line.linesContent) line.linesContent = compact(line.linesContent);
    for (const row of line.table ?? [])
      for (const cell of row.rowContent ?? []) cell.cellContent = compact(cell.cellContent);
  }
  return { before: left.lines, after: right.lines };
}
