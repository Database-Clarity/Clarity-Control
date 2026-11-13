import { parseMarkup, type MarkupGlobals, type MarkupLine, type MarkupSpan } from '@clarity/core';
import { diffWords } from '../../ui/diff/diffWords';
import { INLINE_MAX_SHARE } from '../compendium/compendiumDiffProjection';

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
    // The rendered line of each token and whether it carries ink, for presentDiff's line groups.
    const lineOf: number[] = [];
    const inks: number[] = [];
    let lineIndex = 0;
    const split = (parts: MarkupSpan[], context: unknown): DiffSpan[] =>
      parts.flatMap((part) => {
        const words =
          part.link || part.title || part.text === undefined
            ? [part.text]
            : (part.text.match(/\s+|[^\s]+/g) ?? []);
        return words.map((text) => {
          const span = { ...part, text };
          tokens.push(span);
          lineOf.push(lineIndex);
          inks.push(inkOf(span));
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
      lineOf.push(lineIndex++);
      inks.push(0);
      keys.push(
        encodeURIComponent(
          JSON.stringify(['¶', !!source.table, source.classNames?.includes('spacer')]),
        ),
      );
      return line;
    });
    return { lines, tokens, lineOf, inks, keys: keys.join(' ') };
  }
  const left = side(before),
    right = side(after);
  let a = 0,
    b = 0;
  // Rendered lines that share an unchanged word, icon, link, or title:
  // [previous line, current line]. presentDiff groups lines by them.
  const links: [number, number][] = [];
  for (const part of diffWords(left.keys, right.keys)) {
    const count = part.text.split(/\s+/).filter(Boolean).length;
    for (let i = 0; i < count; i++) {
      if (part.kind === 'equal' && left.inks[a]) links.push([left.lineOf[a], right.lineOf[b]]);
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
  for (const line of [...left.lines, ...right.lines]) eachRun(line, compact);
  const result = { before: left.lines, after: right.lines };
  lineLinks.set(result, links);
  return result;
}

type Diff = ReturnType<typeof renderedDiff>;
const lineLinks = new WeakMap<Diff, [number, number][]>();

/** Visible characters of a span (an icon, link, or title counts at least one); 0 for whitespace. */
function inkOf(span: DiffSpan): number {
  if (span.text === undefined) return span.classNames?.length ? 1 : 0;
  return span.text.replace(/\s+/g, '').length || (span.link || span.title ? 1 : 0);
}

/** Apply `update` to every run of spans a line renders (its content and table cells). */
function eachRun(line: DiffLine, update: (parts: DiffSpan[]) => DiffSpan[]) {
  if (line.linesContent) line.linesContent = update(line.linesContent);
  for (const row of line.table ?? [])
    for (const cell of row.rowContent ?? []) cell.cellContent = update(cell.cellContent);
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

/**
 * Display form of a word diff, applied AFTER source accounting (accountHunks)
 * read it: it only adds marks, so every token a hunk claimed stays marked.
 * - Runs: whitespace between two changes of one kind joins them, so adjacent
 *   changed words read as one highlight instead of one per word; spaces at a
 *   run's edge stay with the unchanged text beside it.
 * - Rewrites: lines linked by unchanged words form a group (one old line split
 *   into several, or the reverse). When the group's changed ink exceeds the
 *   Compendium Changes threshold (INLINE_MAX_SHARE of (removed + added) /
 *   (unchanged on both sides + removed + added)), its old lines read wholly
 *   removed and its new lines wholly added instead of interleaved fragments.
 */
export function presentDiff(diff: Diff): Diff {
  const links = lineLinks.get(diff);
  if (links) {
    const offset = diff.before.length,
      parent = Array.from({ length: offset + diff.after.length }, (_, index) => index);
    const find = (index: number): number =>
      parent[index] === index ? index : (parent[index] = find(parent[index]));
    for (const [from, to] of links) parent[find(from)] = find(offset + to);
    const totals = new Map<number, { changed: number; total: number }>();
    const lines = [...diff.before, ...diff.after];
    lines.forEach((line, index) => {
      const group = find(index);
      const total = totals.get(group) ?? { changed: 0, total: 0 };
      totals.set(group, total);
      eachRun(line, (parts) => {
        for (const part of parts) {
          const ink = inkOf(part);
          total.total += ink;
          if (part.diffKind) total.changed += ink;
        }
        return parts;
      });
    });
    lines.forEach((line, index) => {
      const { changed, total } = totals.get(find(index))!;
      if (!changed || changed / total <= INLINE_MAX_SHARE) return;
      const kind = index < offset ? 'delete' : 'insert';
      eachRun(line, (parts) => parts.map((part) => ({ ...part, diffKind: kind })));
    });
  }
  const plain = (part: DiffSpan) => part.text !== undefined && !part.link && !part.title;
  for (const line of [...diff.before, ...diff.after])
    eachRun(line, (parts) => {
      const joined = compact(
        parts.map((part, index) => {
          const kind = parts[index - 1]?.diffKind;
          return !part.diffKind &&
            kind &&
            kind === parts[index + 1]?.diffKind &&
            plain(part) &&
            !part.text!.trim()
            ? { ...part, diffKind: kind }
            : part;
        }),
      );
      // A run's edge spaces belong to the unchanged text beside it (the word
      // alignment may pair either space), so a highlight starts and ends on ink.
      return compact(
        joined.flatMap((part, index) => {
          const edges = plain(part) && part.diffKind && /^(\s*)(.*?\S)(\s*)$/s.exec(part.text!);
          if (!edges) return [part];
          const [, lead, ink, trail] = edges,
            outside = (text: string, neighbour?: DiffSpan) =>
              text && neighbour?.diffKind !== part.diffKind ? text : '';
          const before = outside(lead, joined[index - 1]),
            after = outside(trail, joined[index + 1]);
          const unmarked: DiffSpan = { ...part };
          delete unmarked.diffKind;
          return [
            ...(before ? [{ ...unmarked, text: before }] : []),
            {
              ...part,
              text: lead.slice(before.length) + ink + trail.slice(0, trail.length - after.length),
            },
            ...(after ? [{ ...unmarked, text: after }] : []),
          ];
        }),
      );
    });
  return diff;
}
