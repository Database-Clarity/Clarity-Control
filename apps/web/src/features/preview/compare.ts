import type { MarkupLine, MarkupSpan } from '@clarity/core';

/**
 * Compare view: the Base render and the Enhanced render read as one text. A line that exists in
 * both but differs shows only what changed (struck base value, an enhanced arrow, the enhanced
 * value); a line only the enhanced version has is marked; a line only the base has is struck.
 * This is a working view of two renders the consumer shows separately — it is never the render
 * itself, which is why it can never count as "previewed".
 */
export type CompareSegment =
  { kind: 'same'; spans: MarkupSpan[] } | { kind: 'change'; was: MarkupSpan[]; now: MarkupSpan[] };

export interface CompareLine {
  kind: 'same' | 'changed' | 'added' | 'removed';
  /** The enhanced line, or the base line when it was removed (its classes lay the line out). */
  line: MarkupLine;
  /** Only for `changed`: the line cut into unchanged runs and changed runs. */
  segments?: CompareSegment[];
}

export interface Comparison {
  lines: CompareLine[];
  /** Lines that are not identical: changed, added and removed. */
  changes: number;
}

const ARROW = 'enhancedArrow';
/** Lines pair up when at least this share of their words agree. */
const PAIRING = 0.5;

interface Token {
  /** What two tokens must share to count as the same. */
  key: string;
  span: MarkupSpan;
  arrow: boolean;
}

function classKey(span: MarkupSpan) {
  return (span.classNames ?? []).filter(Boolean).join(' ');
}

function tokensOf(line: MarkupLine): Token[] {
  const tokens: Token[] = [];
  for (const span of line.linesContent ?? []) {
    const classes = classKey(span);
    if (span.classNames?.includes(ARROW)) {
      tokens.push({ key: 'arrow', span, arrow: true });
    } else if (span.text === undefined || span.link !== undefined || span.title !== undefined) {
      // Icons, links and titles are one word each: a link is changed or not as a whole.
      tokens.push({
        key: `${classes}|${span.text ?? ''}|${span.link ?? ''}|${JSON.stringify(span.title ?? '')}`,
        span,
        arrow: false,
      });
    } else {
      for (const word of span.text.match(/\s+|\S+\s*/g) ?? []) {
        tokens.push({
          key: `${classes}|${word.trim()}`,
          span: { ...span, text: word },
          arrow: false,
        });
      }
    }
  }
  return tokens;
}

/** A spacer: layout only, never content that was added or taken away. */
function isBlank(line: MarkupLine): boolean {
  return (
    !line.table &&
    !(line.linesContent ?? []).some(
      (span) => span.text === undefined || span.text.trim() !== '' || span.link || span.title,
    )
  );
}

function lineKey(line: MarkupLine): string {
  return JSON.stringify([
    line.classNames,
    line.table,
    line.linesContent?.map((span) => [span.text, span.classNames, span.link, span.title]),
  ]);
}

/** Longest common subsequence of two key lists, as matched index pairs. */
function align(a: string[], b: string[]): [number, number][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return pairs;
}

function words(tokens: Token[]) {
  return tokens.filter((token) => !token.arrow && token.key.split('|')[1] !== '');
}

/** 0..1: how much of the longer line's words the two lines share, in order. */
function similarity(before: MarkupLine, after: MarkupLine): number {
  if (before.table || after.table) return 0;
  const a = words(tokensOf(before)).map((token) => token.key);
  const b = words(tokensOf(after)).map((token) => token.key);
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : align(a, b).length / longest;
}

function segmentsOf(before: MarkupLine, after: MarkupLine): CompareSegment[] {
  const a = tokensOf(before);
  const b = tokensOf(after);
  const matched = align(
    a.map((token) => token.key),
    b.map((token) => token.key),
  );
  const segments: CompareSegment[] = [];
  const same = (tokens: Token[]) => {
    if (!tokens.length) return;
    const last = segments[segments.length - 1];
    const spans = tokens.map((token) => token.span);
    if (last?.kind === 'same') last.spans.push(...spans);
    else segments.push({ kind: 'same', spans });
  };
  const change = (was: Token[], now: Token[]) => {
    // The comparison draws its own arrow between the two values.
    const shown = now.filter((token) => !token.arrow).map((token) => token.span);
    // Only an arrow added still reads as a change: the enhanced version marks the spot.
    if (!was.length && !now.length) return;
    segments.push({ kind: 'change', was: was.map((token) => token.span), now: shown });
  };
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matched, [a.length, b.length] as [number, number]]) {
    change(a.slice(i, mi), b.slice(j, mj));
    if (mi < a.length) same([b[mj]]);
    i = mi + 1;
    j = mj + 1;
  }
  return segments;
}

/** Order-preserving pairing of the lines that differ: best total similarity, nothing crossing. */
function pair(before: MarkupLine[], after: MarkupLine[]): [number, number][] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const score = new Float64Array(rows * cols);
  const sims = new Map<number, number>();
  const sim = (i: number, j: number) => {
    const key = i * cols + j;
    let value = sims.get(key);
    if (value === undefined) {
      value = similarity(before[i], after[j]);
      sims.set(key, value);
    }
    return value >= PAIRING ? value : 0;
  };
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--) {
      const s = sim(i, j);
      score[i * cols + j] = Math.max(
        score[(i + 1) * cols + j],
        score[i * cols + j + 1],
        s > 0 ? score[(i + 1) * cols + j + 1] + s : 0,
      );
    }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const s = sim(i, j);
    if (s > 0 && score[i * cols + j] === score[(i + 1) * cols + j + 1] + s) pairs.push([i++, j++]);
    else if (score[(i + 1) * cols + j] >= score[i * cols + j + 1]) i++;
    else j++;
  }
  return pairs;
}

export function compareRenders(base: MarkupLine[], enhanced: MarkupLine[]): Comparison {
  const result: CompareLine[] = [];
  // Identical lines at both ends are matched without any work; the middle is paired by similarity.
  let start = 0;
  while (
    start < base.length &&
    start < enhanced.length &&
    lineKey(base[start]) === lineKey(enhanced[start])
  )
    result.push({ kind: 'same', line: enhanced[start++] });
  let endBase = base.length;
  let endEnhanced = enhanced.length;
  const tail: CompareLine[] = [];
  while (
    endBase > start &&
    endEnhanced > start &&
    lineKey(base[endBase - 1]) === lineKey(enhanced[endEnhanced - 1])
  ) {
    endBase--;
    tail.unshift({ kind: 'same', line: enhanced[--endEnhanced] });
  }

  const middleBase = base.slice(start, endBase);
  const middleEnhanced = enhanced.slice(start, endEnhanced);
  // Exact matches anchor the middle first so a repeated line cannot steal another's partner.
  const anchors = align(middleBase.map(lineKey), middleEnhanced.map(lineKey));
  let bi = 0;
  let ei = 0;
  const flush = (toBase: number, toEnhanced: number) => {
    const before = middleBase.slice(bi, toBase);
    const after = middleEnhanced.slice(ei, toEnhanced);
    const paired = pair(before, after);
    let pi = 0;
    let pj = 0;
    for (const [i, j] of [...paired, [before.length, after.length] as [number, number]]) {
      for (; pi < i; pi++)
        if (!isBlank(before[pi])) result.push({ kind: 'removed', line: before[pi] });
      for (; pj < j; pj++)
        result.push({ kind: isBlank(after[pj]) ? 'same' : 'added', line: after[pj] });
      if (i < before.length)
        result.push({
          kind: 'changed',
          line: after[j],
          segments: segmentsOf(before[i], after[j]),
        });
      pi = i + 1;
      pj = j + 1;
    }
  };
  for (const [i, j] of anchors) {
    flush(i, j);
    result.push({ kind: 'same', line: middleEnhanced[j] });
    bi = i + 1;
    ei = j + 1;
  }
  flush(middleBase.length, middleEnhanced.length);
  result.push(...tail);
  return { lines: result, changes: result.filter((line) => line.kind !== 'same').length };
}
