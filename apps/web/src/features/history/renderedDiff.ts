import { parseMarkup, type MarkupGlobals, type MarkupLine, type MarkupSpan } from '@clarity/core';
import { diffWords } from '../../ui/diff/diffWords';

export interface DiffSpan extends MarkupSpan {
  diffKind?: 'insert' | 'delete';
}
/** A line whose structure token (break, spacer, line class, or table) changed. */
export type DiffLine = MarkupLine & { diffKind?: 'insert' | 'delete' };

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
  // With only one side there is nothing to align. Preserve the preview's spans
  // directly instead of splitting, encoding, aligning, and recombining words.
  if (!precise || !before || !after) {
    const coarse = (text: string, diffKind: DiffSpan['diffKind']) => {
      const lines: DiffLine[] = text ? parseMarkup(text, globals).lines : [];
      for (const line of lines) {
        line.diffKind = diffKind;
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
    // Word, icon, link, and title spans, plus one structure token per line, in render order.
    const tokens: (DiffSpan | DiffLine)[] = [];
    const split = (parts: MarkupSpan[], context: unknown): DiffSpan[] =>
      parts.flatMap((part) => {
        const words =
          part.link || part.title || part.text === undefined
            ? [part.text]
            : (part.text.match(/\s+|[^\s]+/g) ?? []);
        return words.map((text) => {
          const span = { ...part, text };
          tokens.push(span);
          // One whitespace-free diff token per rendered word, icon, link, or title.
          keys.push(encodeURIComponent(JSON.stringify([span, context])));
          return span;
        });
      });
    const lines: DiffLine[] = parseMarkup(text, globals).lines.map((source) => {
      const line: DiffLine = { ...source };
      line.linesContent = source.linesContent && split(source.linesContent, source.classNames);
      line.table = source.table?.map((row) => ({
        ...row,
        rowContent: row.rowContent?.map((cell) => ({
          ...cell,
          cellContent: split(cell.cellContent, [
            source.classNames,
            row.classNames,
            cell.classNames,
            cell.colSpan,
            cell.rowSpan,
          ]),
        })),
      }));
      // Each line ends with one structure token, so an added or removed line
      // (break, spacer, or table) is marked in the same stream as words, on the
      // line it creates or removes; the spacer flag keeps a new blank line's
      // mark on that line. It carries no classes: a class change already marks
      // every span on its line, and a break change must own its mark alone.
      tokens.push(line);
      keys.push(
        encodeURIComponent(
          JSON.stringify(['¶', !!source.table, source.classNames?.includes('spacer')]),
        ),
      );
      return line;
    });
    return { lines, tokens, keys: keys.join(' ') };
  }
  const left = side(before),
    right = side(after);
  let a = 0,
    b = 0;
  for (const part of diffWords(left.keys, right.keys)) {
    const count = part.text.split(/\s+/).filter(Boolean).length;
    for (let i = 0; i < count; i++) {
      if (part.kind !== 'insert') {
        if (part.kind === 'delete') left.tokens[a].diffKind = 'delete';
        a++;
      }
      if (part.kind !== 'delete') {
        if (part.kind === 'insert') right.tokens[b].diffKind = 'insert';
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
