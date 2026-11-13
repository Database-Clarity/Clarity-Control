import {
  markupColors,
  markupCommentContext,
  markupIcons,
  markupLineClasses,
  markupDefinitions,
  extractBlocks,
  parseMarkup,
  scanBaseEnhanced,
  type MarkupGlobals,
} from '@clarity/core';
import {
  markupConditionMatches,
  markupConditions,
} from '../../../../../packages/core/src/markup/prepare';
import { diffWords } from '../../ui/diff/diffWords';
import type { DiffLine, DiffSpan, renderedDiff } from './renderedDiff';

interface Unit {
  from: number;
  to: number;
  text: string;
  kind: string;
}
interface Part {
  from: number;
  to: number;
  nextFrom: number;
  nextTo: number;
  kind: string;
}
export interface SourceMarker {
  /** The current side's rendered line the marker sits above. */
  position: number;
  label: string;
  /** Raw hunks this marker covers (markers on one rendered line collapse into one). */
  hunks: number;
  /** Source lines covered per side, 1-based and inclusive; null where that side is empty. */
  previous: [number, number] | null;
  current: [number, number] | null;
}
export interface SourceAnalysis {
  markers: SourceMarker[];
}
/** How one raw source hunk is accounted for in the final rendered diff. */
export type HunkAccount =
  | {
      account: 'shown';
      /** Final-diff tokens this hunk claimed: [side, rendered line, word or '¶']. */
      tokens: ['before' | 'after', number, string][];
    }
  | { account: 'marker'; marker: SourceMarker };

// Only production recognizers identify markup. Ordinary text is split for the
// raw diff; recognized blocks remain indivisible, including all-new documents.
function units(text: string): Unit[] {
  const clean = markupCommentContext(text);
  const ranges = clean.comments.map((range) => ({ ...range, kind: 'comment' }));
  for (const [keyword] of markupConditions)
    for (const match of markupConditionMatches(clean.text, keyword)) {
      const from = clean.offsets[match.index!],
        to = clean.offsets[match.index! + match[0].length - 1] + 1;
      ranges.push({ from, to, kind: keyword });
    }
  for (const pair of scanBaseEnhanced(clean.text).pairs)
    ranges.push({
      from: clean.offsets[pair.from],
      to: clean.offsets[pair.to - 1] + 1,
      kind: 'base/enhanced',
    });
  for (const definition of markupDefinitions(text))
    if (definition.kind === 'variable') {
      const from = text.lastIndexOf('\n', definition.from) + 1;
      const end = text.indexOf('\n', definition.to);
      ranges.push({ from, to: end < 0 ? text.length : end, kind: 'variable' });
    }
  // Line-anchored production constructs carry their separating newline, so
  // inserting a declaration alone cannot accidentally append it to plain text.
  for (const range of ranges)
    if (range.kind !== 'base/enhanced' && text[range.from - 1] === '\n') range.from--;
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const result: Unit[] = [];
  const plain = (from: number, to: number) => {
    for (const match of text.slice(from, to).matchAll(/\s+|[^\s]+/g))
      result.push({
        from: from + match.index!,
        to: from + match.index! + match[0].length,
        text: match[0],
        kind: 'source',
      });
  };
  let cursor = 0;
  for (const range of ranges) {
    if (range.to <= cursor) continue;
    const from = Math.max(cursor, range.from);
    plain(cursor, from);
    result.push({ ...range, from, text: text.slice(from, range.to) });
    cursor = range.to;
  }
  plain(cursor, text.length);
  return result;
}

export function sourceParts(before: string, after: string): Part[] {
  const left = units(before),
    right = units(after),
    parts: Part[] = [];
  const encode = (list: Unit[]) =>
    list.map((unit) => 'L' + encodeURIComponent(JSON.stringify(unit.text))).join(' ');
  let a = 0,
    b = 0,
    pending: Part | undefined;
  const offset = (list: Unit[], index: number, text: string) => list[index]?.from ?? text.length;
  const add = (part: Part) => {
    const last = parts.at(-1);
    if (
      last &&
      last.kind === part.kind &&
      last.to === part.from &&
      last.nextTo === part.nextFrom &&
      ((last.nextFrom === last.nextTo && part.from === part.to) ||
        (last.from === last.to && part.nextFrom === part.nextTo))
    ) {
      last.to = part.to;
      last.nextTo = part.nextTo;
    } else parts.push(part);
  };
  const flush = () => {
    if (pending) add(pending);
    pending = undefined;
  };
  for (const change of diffWords(encode(left), encode(right))) {
    const count = change.text.split(/\s+/).filter(Boolean).length;
    if (!count) continue; // Separators between encoded source units are not source.
    if (change.kind === 'equal') {
      flush();
      a += count;
      b += count;
      continue;
    }
    for (let i = 0; i < count; i++) {
      const old = offset(left, a, before),
        next = offset(right, b, after);
      const unit = change.kind === 'delete' ? left[a++] : right[b++];
      const part = {
        from: old,
        to: offset(left, a, before),
        nextFrom: next,
        nextTo: offset(right, b, after),
        kind: unit.kind,
      };
      if (unit.kind !== 'source') {
        flush();
        add(part);
      } else if (pending) {
        pending.to = part.to;
        pending.nextTo = part.nextTo;
      } else pending = part;
    }
  }
  flush();
  return parts;
}

// Source characters whose meaning is markup in production: variable references,
// tags, table cells, native pairs, title/link targets, math, and comment
// delimiters. Outside a recognised inline token, a hunk containing one is
// never accounted as shown.
const markupCharacters = /[#<>|{}[\]$\r]|\/\/|\/\*|\*\//;
// Whole lines that production removes, replaces, or reads as structure.
const constructLines = [
  /^var /,
  /^title /,
  /^export /,
  /^import /,
  /^(enhanced|catalyst|exotic perk) \(/,
  /^\) *$/,
  /^< table /,
  /^<\$>/,
  /^\s*<weapons/i,
  /^\s*<\s*(?:weapon type\s*)?\(.*\)\s*>\s*$/,
  /^\s*(<\/weapons\s*>|<\$\$>)\s*$/i,
];
const textWrappers = new Set<string>([...markupColors, 'background', 'bold']);
const words = (text: string) => text.split(/\s+/).filter(Boolean);
const breaks = (text: string) => text.split('\n').length - 1;
type Side = 'before' | 'after';

/** A complete inline tag and the marked final-diff tokens it must claim (null: unprovable). */
interface InlineToken {
  from: number;
  to: number;
  /** A text wrapper's inner words, which render literally in its colour. */
  inner?: [number, number];
  expect: string[] | null;
}

/**
 * Where production renders source as itself. `context` is 1 outside hidden or
 * transformed regions (comments, definitions, conditions, native pairs, tables,
 * construct lines, math, lines with a variable reference, and lines with a
 * stray tag); `tokens`
 * lists the inline tags, which render only as their own spans. Deliberately
 * conservative: a wrong 0 or null only costs a redundant marker, never a
 * vanished edit.
 */
function sourceContext(text: string) {
  const context = new Uint8Array(text.length).fill(1);
  const tokens: InlineToken[] = [];
  const clear = (from: number, to: number) => context.fill(0, Math.max(0, from), to);
  const clean = markupCommentContext(text);
  for (const range of clean.comments) clear(range.from, range.to);
  const cleanRange = (index: number, length: number) =>
    clear(clean.offsets[index], (clean.offsets[index + length - 1] ?? text.length - 1) + 1);
  const blocks = [
    /^title .+ \([^]*?\n\)$/gm,
    /^export .* \([^]*?\n\)$/gm,
    /^< table [^]*?\n<\$>$/gm,
    ...markupConditions.map(([keyword]) => new RegExp(`^${keyword} \\([\\s\\S]*?\\n\\)$`, 'gm')),
  ];
  for (const pattern of blocks)
    for (const match of clean.text.matchAll(pattern)) cleanRange(match.index, match[0].length);
  for (const pair of scanBaseEnhanced(clean.text).pairs) cleanRange(pair.from, pair.to - pair.from);
  let start = 0;
  for (const line of text.split('\n')) {
    const end = start + line.length;
    // A reference's value can change with another hunk (a declaration, global,
    // or import) and cancel or supply words on its line, so a line holding one
    // never proves an edit. Neither do construct lines.
    if (/#[a-zA-Z0-9]/.test(line) || constructLines.some((pattern) => pattern.test(line)))
      clear(start, end + 1);
    for (const match of line.matchAll(/\$\{.+?\}/g))
      clear(start + match.index, start + match.index + match[0].length);
    // Production lifts the first marker of each line class off the line, then
    // reads inline tags. A class change shares its line's structure token with
    // any break change on that line, so it cannot own the mark: always flagged.
    let scan = line;
    for (const name of markupLineClasses) {
      const marker = `<${name}/>`,
        index = scan.indexOf(marker);
      if (index < 0) continue;
      tokens.push({ from: start + index, to: start + index + marker.length, expect: null });
      scan = scan.slice(0, index) + ' '.repeat(marker.length) + scan.slice(index + marker.length);
    }
    for (const match of scan.matchAll(/<.+?\/>/g)) {
      const source = match[0],
        from = start + match.index,
        to = from + source.length;
      const wrapper = /^<(\w+)/.exec(source)?.[1] ?? '';
      const target = /^<(link|title) ([^[\]<>]+) \[([^[\]<>]+)\] \/>$/.exec(source);
      if (
        textWrappers.has(wrapper) &&
        source.startsWith(`<${wrapper} `) &&
        source.endsWith(' />')
      ) {
        const inner = source.slice(wrapper.length + 2, -3);
        tokens.push({
          from,
          to,
          inner: [from + wrapper.length + 2, to - 3],
          expect: markupCharacters.test(inner) ? null : words(inner),
        });
      } else if (markupIcons.includes(wrapper) && source === `<${wrapper}/>`)
        tokens.push({ from, to, expect: [source] });
      else if (target)
        tokens.push({
          from,
          to,
          expect: [
            target[1] === 'link' ? `‹link›${target[2]}›${target[3]}` : `‹title›${target[2]}`,
          ],
        });
      else tokens.push({ from, to, expect: null });
      scan =
        scan.slice(0, match.index) +
        ' '.repeat(source.length) +
        scan.slice(match.index + source.length);
    }
    // Outside complete tags, production drops or recolours text after a stray
    // '<word' (and reads a stray '/>' as tag syntax): never prove that line.
    if (/[<>]/.test(scan)) clear(start, end + 1);
    start = end + 1;
  }
  tokens.sort((a, b) => a.from - b.from);
  // Ownership: words rendered by a hidden or transformed region (a comment,
  // reference, native pair, math, or unprovable tag) share their rendered line
  // with literal text and could stand in for, or cancel, a literal edit there.
  // A line is provable only when all of it is literal text or complete tags.
  start = 0;
  for (const line of text.split('\n')) {
    const end = start + line.length;
    if (
      context.subarray(start, end).includes(0) ||
      tokens.some((token) => !token.expect && token.from < end && token.to > start)
    )
      clear(start, end + 1);
    start = end + 1;
  }
  return { context, tokens };
}

/**
 * Accounts for every raw source hunk against the FINAL rendered diff (the
 * renderedDiff output the user sees). A source hunk is "shown" only when each
 * rendered piece it should produce (literal words, complete icon, link, title,
 * and colour tags, line classes, and a line break it adds or removes) claims a
 * distinct marked token on the rendered lines it occupies. Every other hunk
 * gets a located marker. Every hunk is checked: there is no part cap or time
 * budget, so one text pair always gets one complete account.
 */
export function accountHunks(
  before: string,
  after: string,
  globals: MarkupGlobals,
  diff: ReturnType<typeof renderedDiff>,
): HunkAccount[] {
  return drain(accountHunkSteps(before, after, globals, diff));
}

function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * accountHunks as steps: it yields after each raw hunk so a worker can pause
 * between hunks (and drop a cancelled check). It reads `diff` while it runs,
 * so the caller must not change `diff` (presentDiff) until it is done.
 */
export function* accountHunkSteps(
  before: string,
  after: string,
  globals: MarkupGlobals,
  diff: ReturnType<typeof renderedDiff>,
): Generator<void, HunkAccount[]> {
  const parts = sourceParts(before, after);
  const texts = { before, after };
  const sources = { before: sourceContext(before), after: sourceContext(after) };
  // Marked tokens of the final diff, per side and rendered line. Tables are
  // never provable, so only line structure and line content can be claimed.
  type Token = { line: number; word: string; used: boolean };
  const pool = (lines: DiffLine[], kind: 'insert' | 'delete') => {
    const tokens: Token[] = [];
    lines.forEach((line, index) => {
      const add = (word: string) => tokens.push({ line: index, word, used: false });
      if (line.diffKind === kind) add('¶');
      for (const span of (line.linesContent ?? []) as DiffSpan[]) {
        if (span.diffKind !== kind) continue;
        if (span.link) add(`‹link›${span.text}›${span.link}`);
        else if (span.title) add(`‹title›${span.text}`);
        else if (span.text) words(span.text).forEach(add);
        else for (const name of span.classNames ?? []) add(`<${name}/>`);
      }
    });
    return tokens;
  };
  const pools = { before: pool(diff.before, 'delete'), after: pool(diff.after, 'insert') };
  // What a source range must claim, or null when it cannot be proven cheaply.
  const expectation = (side: Side, from: number, to: number): string[] | null => {
    const { context, tokens } = sources[side];
    if (!context.subarray(from, to).every((bit) => bit === 1)) return null;
    const pieces: string[] = [],
      expected: string[] = [];
    let at = from;
    for (const token of tokens) {
      if (token.to <= from || token.from >= to) continue;
      if (token.inner && from >= token.inner[0] && to <= token.inner[1]) continue;
      if (token.from < from || token.to > to || !token.expect) return null;
      pieces.push(texts[side].slice(at, token.from));
      expected.push(...token.expect);
      at = token.to;
    }
    pieces.push(texts[side].slice(at, to));
    const rest = pieces.join(' ');
    return markupCharacters.test(rest) ? null : [...words(rest), ...expected];
  };
  // Line breaks render only between literal, rendered text: next to hidden or
  // removed source, or at either end of the document, production collapses or
  // trims them. Every whitespace run a break-changing hunk touches must be
  // bounded by literal text on both sides.
  const settled = (side: Side, from: number, to: number) => {
    const text = texts[side],
      { context } = sources[side];
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    while (to < text.length && /\s/.test(text[to])) to++;
    for (const run of text.slice(from, to).matchAll(/\s*\n\s*/g)) {
      const a = from + run.index,
        b = a + run[0].length;
      if (a === 0 || b === text.length || !context[a - 1] || !context[b]) return false;
    }
    return true;
  };
  // Rendered line of a source offset; the 'x' keeps a trailing break counted
  // (on its own line after a block closer, so it cannot break that block).
  const lineAt = (side: Side, offset: number) => {
    const prefix = texts[side].slice(0, offset),
      own = /(^|\n)(\) *|<\$>)$/.test(prefix);
    const lines = parseMarkup(prefix + (own ? '\nx' : 'x'), globals).lines.length;
    return Math.min(diff[side].length, Math.max(0, lines - 1));
  };
  const definitions = (text: string) => {
    const clean = markupCommentContext(text),
      bodies = extractBlocks(clean.text, 'title');
    return markupDefinitions(text).map((definition) => {
      if (definition.kind === 'variable') {
        const end = text.indexOf('\n', definition.to);
        return {
          from: text.lastIndexOf('\n', definition.from) + 1,
          to: end < 0 ? text.length : end,
          label: `Variable ${definition.name} changed`,
        };
      }
      const nameEnd = clean.offsets.findIndex((offset) => offset >= definition.to);
      const bodyStart = clean.text.indexOf('\n', nameEnd) + 1;
      const bodyEnd = bodyStart + (bodies[definition.name]?.length ?? 0);
      return {
        from: definition.from,
        to: clean.offsets[Math.max(bodyStart, bodyEnd - 1)] + 1,
        label: `Title ${definition.name} changed`,
      };
    });
  };
  type Definitions = ReturnType<typeof definitions>;
  const known: Partial<Record<Side, Definitions>> = {};
  const overlapping = (side: Side, from: number, to: number) =>
    (known[side] ??= definitions(texts[side])).find(
      (range) => from < range.to && Math.max(to, from + 1) > range.from,
    );
  const sourceLine = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
  const startLine = (text: string, offset: number) =>
    sourceLine(text, offset) + (text[offset] === '\n' ? 1 : 0);
  // Per marker, whether each side is only an insertion point ("at line N").
  const insertion = new Map<SourceMarker, [boolean, boolean]>();

  const inertSpacing = (part: Part, old: string, next: string) =>
    part.kind === 'source' &&
    !(old + next).trim() &&
    breaks(old) === breaks(next) &&
    (['before', 'after'] as const).every((side) => {
      const [from, to] = side === 'before' ? [part.from, part.to] : [part.nextFrom, part.nextTo];
      const { context } = sources[side],
        text = texts[side];
      // Both neighbours (or the document edge) render literally, and so does every line touched.
      const low = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1,
        end = text.indexOf('\n', to),
        high = end < 0 ? text.length : end;
      return context.subarray(low, high).every((bit) => bit === 1);
    });

  const accounts: HunkAccount[] = [];
  const flagged: { side: Side; low: number; high: number }[] = [];
  for (const part of parts) {
    if (accounts.length) yield;
    const old = before.slice(part.from, part.to),
      next = after.slice(part.nextFrom, part.nextTo);
    const expected =
      part.kind === 'source'
        ? {
            before: expectation('before', part.from, part.to),
            after: expectation('after', part.nextFrom, part.nextTo),
          }
        : undefined;
    const provable =
      !!expected?.before &&
      !!expected.after &&
      (!/\n/.test(old + next) ||
        (settled('before', part.from, part.to) && settled('after', part.nextFrom, part.nextTo)));
    const added = breaks(next) - breaks(old);
    const needed = {
      before: [...(expected?.before ?? []), ...(added < 0 ? ['¶'] : [])],
      after: [...(expected?.after ?? []), ...(added > 0 ? ['¶'] : [])],
    };
    let shown: ['before' | 'after', number, string][] | undefined;
    if (provable && (needed.before.length || needed.after.length)) {
      const claims: Token[] = [];
      const claim = (side: Side, from: number, to: number, needed: string[]) => {
        if (!needed.length) return true;
        const low = lineAt(side, from),
          high = lineAt(side, to);
        for (const word of needed) {
          const token = pools[side].find(
            (candidate) =>
              !candidate.used &&
              candidate.word === word &&
              candidate.line >= low &&
              candidate.line <= high,
          );
          if (!token) return false;
          token.used = true;
          claims.push(token);
          (shown ??= []).push([side, token.line, word]);
        }
        return true;
      };
      const ok =
        claim('before', part.from, part.to, needed.before) &&
        claim('after', part.nextFrom, part.nextTo, needed.after);
      if (!ok) {
        for (const token of claims) token.used = false;
        shown = undefined;
      }
    }
    // Where a flagged part renders: a shown claim on one of these lines could
    // be that part's word, or be cancelled by it, so it is not proof. Spacing
    // that keeps its break count between literal, provable text renders no
    // word or break (production collapses and trims it), so it can neither
    // stand in for nor cancel a claim: it keeps its own marker only.
    if (!shown && !inertSpacing(part, old, next))
      for (const [side, from, to] of [
        ['before', part.from, part.to],
        ['after', part.nextFrom, part.nextTo],
      ] as const)
        if (texts[side]) {
          // Line-anchored constructs carry their separating break; locate their content.
          const text = texts[side].slice(from, to),
            lead = text.length - text.replace(/^\n+/, '').length,
            trail = text.length - text.replace(/\n+$/, '').length;
          const low = lead < text.length ? from + lead : from,
            high = lead < text.length ? to - trail : to;
          flagged.push({ side, low: lineAt(side, low), high: lineAt(side, high) });
        }
    if (shown) {
      accounts.push({ account: 'shown', tokens: shown });
      continue;
    }
    accounts.push(marker(part, provable));
  }
  // Demote shown parts that share a rendered line with a flagged part.
  accounts.forEach((entry, index) => {
    if (entry.account !== 'shown') return;
    const shares = entry.tokens.some(([side, line]) =>
      flagged.some((range) => range.side === side && line >= range.low && line <= range.high),
    );
    if (shares) accounts[index] = marker(parts[index], true);
  });
  return collapse(accounts);

  function marker(part: (typeof parts)[number], provable: boolean): HunkAccount {
    const old = before.slice(part.from, part.to),
      next = after.slice(part.nextFrom, part.nextTo);
    const definition =
      !provable && (part.kind === 'source' || part.kind === 'variable')
        ? (overlapping('after', part.nextFrom, part.nextTo) ??
          overlapping('before', part.from, part.to))
        : undefined;
    const label = !(old + next).trim()
      ? 'Line break or spacing'
      : provable
        ? 'Text'
        : (definition?.label ??
          (part.kind === 'source'
            ? 'Markup'
            : part.kind === 'base/enhanced'
              ? 'Base/enhanced pair'
              : part.kind[0].toUpperCase() + part.kind.slice(1)));
    const lines = (text: string, from: number, to: number): [number, number] | null =>
      !text
        ? null
        : from === to
          ? [sourceLine(text, from), sourceLine(text, from)]
          : [
              Math.min(startLine(text, from), sourceLine(text, Math.max(from, to - 1))),
              sourceLine(text, Math.max(from, to - 1)),
            ];
    const located: SourceMarker = {
      position: after ? lineAt('after', part.nextFrom) : 0,
      label,
      hunks: 1,
      previous: lines(before, part.from, part.to),
      current: lines(after, part.nextFrom, part.nextTo),
    };
    insertion.set(located, [part.from === part.to, part.nextFrom === part.nextTo]);
    return { account: 'marker', marker: located };
  }

  /**
   * One marker per rendered line: every marker account on a line shares one
   * marker listing its labels once and the union of their source lines, so no
   * hunk it absorbed loses its location.
   */
  function collapse(list: HunkAccount[]): HunkAccount[] {
    const byLine = new Map<number, SourceMarker>();
    const kinds = new Map<number, string[]>();
    for (const entry of list) {
      if (entry.account !== 'marker') continue;
      const own = entry.marker;
      const shared = byLine.get(own.position);
      if (!shared) {
        byLine.set(own.position, own);
        kinds.set(own.position, [own.label]);
        continue;
      }
      const union = (a: [number, number] | null, b: [number, number] | null) =>
        a && b ? ([Math.min(a[0], b[0]), Math.max(a[1], b[1])] as [number, number]) : (a ?? b);
      shared.previous = union(shared.previous, own.previous);
      shared.current = union(shared.current, own.current);
      const [a, b] = [insertion.get(shared)!, insertion.get(own)!];
      insertion.set(shared, [a[0] && b[0], a[1] && b[1]]);
      shared.hunks++;
      const labels = kinds.get(own.position)!;
      if (!labels.includes(own.label)) labels.push(own.label);
      entry.marker = shared;
    }
    const describe = (lines: [number, number] | null, at: boolean) =>
      !lines
        ? 'not present'
        : at
          ? `at line ${lines[0]}`
          : lines[0] === lines[1]
            ? `line ${lines[0]}`
            : `lines ${lines[0]}–${lines[1]}`;
    for (const [position, shared] of byLine) {
      const [previous, current] = insertion.get(shared)!;
      shared.label = `Source changed · ${kinds.get(position)!.join(', ')} · previous ${describe(shared.previous, previous)}; current ${describe(shared.current, current)} · see Raw`;
    }
    return list;
  }
}

/** Worker-only summary of accountHunks for the rendered view. */
export function analyzeSourceOnly(
  before: string,
  after: string,
  globals: MarkupGlobals,
  diff: ReturnType<typeof renderedDiff>,
): SourceAnalysis {
  return drain(sourceAnalysisSteps(before, after, globals, diff));
}

/** analyzeSourceOnly as steps (see accountHunkSteps). */
export function* sourceAnalysisSteps(
  before: string,
  after: string,
  globals: MarkupGlobals,
  diff: ReturnType<typeof renderedDiff>,
): Generator<void, SourceAnalysis> {
  const accounts = yield* accountHunkSteps(before, after, globals, diff);
  return {
    // Collapsed markers are shared by every hunk they cover: list each once.
    markers: [
      ...new Set(accounts.flatMap((entry) => (entry.account === 'marker' ? [entry.marker] : []))),
    ],
  };
}
