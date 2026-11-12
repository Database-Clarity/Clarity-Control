import {
  markupColors,
  markupCommentContext,
  markupDefinitions,
  extractBlocks,
  extractVariables,
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
  position: number;
  label: string;
}
export interface SourceAnalysis {
  markers: SourceMarker[];
  unchecked: number;
}
/** How one raw source hunk is accounted for in the final rendered diff. */
export type HunkAccount =
  | {
      account: 'shown';
      /** Final-diff tokens this hunk claimed: [side, rendered line, word or '¶']. */
      tokens: ['before' | 'after', number, string][];
    }
  | { account: 'marker'; marker: SourceMarker }
  | { account: 'unchecked' };

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
// tags, table cells, native pairs, title/link targets, math, the enhanced arrow,
// and comment delimiters. A hunk containing one is never "plain text".
const markupCharacters = /[#<>|{}[\]$\r]|🡅|\/\/|\/\*|\*\//u;
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

/**
 * 1 where a source character renders literally as plain text, 0 where production
 * may hide, move, replace, or restyle it. Deliberately conservative: a wrong 0
 * only costs a redundant marker, while a wrong 1 could let an edit vanish.
 */
function literalMask(text: string, globals: MarkupGlobals): Uint8Array {
  const mask = new Uint8Array(text.length).fill(1);
  const clear = (from: number, to: number) => mask.fill(0, Math.max(0, from), to);
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
  // A reference whose value carries markup could wrap neighbouring text in a tag.
  const values = { ...extractVariables(text), ...extractVariables(globals.variables) };
  let start = 0;
  for (const line of text.split('\n')) {
    const end = start + line.length;
    const markupValue = (line.match(/#[a-zA-Z0-9]+/g) ?? []).some((reference) => {
      const value = values[reference.slice(1)];
      return value === undefined || markupCharacters.test(value);
    });
    if (markupValue || constructLines.some((pattern) => pattern.test(line))) clear(start, end + 1);
    for (const match of line.matchAll(/<.+?\/>/g)) {
      const from = start + match.index,
        to = from + match[0].length;
      clear(from, to);
      // Only a text wrapper's inner words render literally (in its colour).
      const wrapper = /^<(\w+) /.exec(match[0]);
      if (wrapper && textWrappers.has(wrapper[1]) && match[0].endsWith(' />'))
        mask.fill(1, from + wrapper[0].length, to - 3);
    }
    for (const match of line.matchAll(/\$\{.+?\}/g))
      clear(start + match.index, start + match.index + match[0].length);
    start = end + 1;
  }
  return mask;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const breaks = (text: string) => text.split('\n').length - 1;
type Side = 'before' | 'after';

/**
 * Accounts for every raw source hunk against the FINAL rendered diff (the
 * renderedDiff output the user sees). A plain-text hunk is "shown" only when
 * each of its words, and a line break it adds or removes, claims a distinct
 * marked token on the rendered lines it occupies. Every other hunk inside the
 * budget gets a located marker; the rest are unchecked.
 */
export function accountHunks(
  before: string,
  after: string,
  globals: MarkupGlobals,
  diff: ReturnType<typeof renderedDiff>,
  options: { maxParts?: number; budgetMs?: number; now?: () => number } = {},
): HunkAccount[] {
  const now = options.now ?? (() => performance.now()),
    start = now(),
    budget = options.budgetMs ?? 50,
    maxParts = options.maxParts ?? 40;
  const parts = sourceParts(before, after);
  const texts = { before, after };
  const masks = { before: literalMask(before, globals), after: literalMask(after, globals) };
  // Marked tokens of the final diff, per side and rendered line. Tables are
  // never plain text, so only line structure and line content can be claimed.
  type Token = { line: number; word: string; used: boolean };
  const pool = (lines: DiffLine[], kind: 'insert' | 'delete') => {
    const tokens: Token[] = [];
    lines.forEach((line, index) => {
      if (line.diffKind === kind) tokens.push({ line: index, word: '¶', used: false });
      for (const span of (line.linesContent ?? []) as DiffSpan[])
        if (span.diffKind === kind && !span.link && !span.title && span.text)
          for (const word of words(span.text)) tokens.push({ line: index, word, used: false });
    });
    return tokens;
  };
  const pools = { before: pool(diff.before, 'delete'), after: pool(diff.after, 'insert') };
  // Rendered line of a source offset; the 'x' keeps a trailing break counted.
  const lineAt = (side: Side, offset: number) =>
    Math.min(
      diff[side].length,
      Math.max(0, parseMarkup(texts[side].slice(0, offset) + 'x', globals).lines.length - 1),
    );
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
  const range = (text: string, from: number, to: number) =>
    !text
      ? 'not present'
      : from === to
        ? `at line ${sourceLine(text, from)}`
        : startLine(text, from) === sourceLine(text, Math.max(from, to - 1))
          ? `line ${startLine(text, from)}`
          : `lines ${startLine(text, from)}–${sourceLine(text, to - 1)}`;
  const literal = (side: Side, from: number, to: number) =>
    masks[side].subarray(from, to).every((bit) => bit === 1);

  const accounts: HunkAccount[] = [];
  for (const part of parts) {
    if (accounts.length >= maxParts || now() - start >= budget) break;
    const old = before.slice(part.from, part.to),
      next = after.slice(part.nextFrom, part.nextTo);
    const plain =
      part.kind === 'source' &&
      !markupCharacters.test(old) &&
      !markupCharacters.test(next) &&
      literal('before', part.from, part.to) &&
      literal('after', part.nextFrom, part.nextTo);
    const added = breaks(next) - breaks(old);
    let shown: ['before' | 'after', number, string][] | undefined;
    if (plain && (words(old).length || words(next).length || added)) {
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
        claim('before', part.from, part.to, [...words(old), ...(added < 0 ? ['¶'] : [])]) &&
        claim('after', part.nextFrom, part.nextTo, [...words(next), ...(added > 0 ? ['¶'] : [])]);
      if (!ok) {
        for (const token of claims) token.used = false;
        shown = undefined;
      }
    }
    // A part whose renders overran the budget is not checked.
    if (now() - start >= budget) break;
    if (shown) {
      accounts.push({ account: 'shown', tokens: shown });
      continue;
    }
    const definition =
      !plain && (part.kind === 'source' || part.kind === 'variable')
        ? (overlapping('after', part.nextFrom, part.nextTo) ??
          overlapping('before', part.from, part.to))
        : undefined;
    const label = plain
      ? words(old).length || words(next).length
        ? 'Text'
        : 'Line break or spacing'
      : (definition?.label ??
        (part.kind === 'source'
          ? 'Markup'
          : part.kind === 'base/enhanced'
            ? 'Base/enhanced pair'
            : part.kind[0].toUpperCase() + part.kind.slice(1)));
    accounts.push({
      account: 'marker',
      marker: {
        position: after ? lineAt('after', part.nextFrom) : 0,
        label: `Source changed · ${label} · previous ${range(before, part.from, part.to)}; current ${range(after, part.nextFrom, part.nextTo)} · see Raw`,
      },
    });
  }
  while (accounts.length < parts.length) accounts.push({ account: 'unchecked' });
  return accounts;
}

/** Worker-only summary of accountHunks for the rendered view. */
export function analyzeSourceOnly(
  before: string,
  after: string,
  globals: MarkupGlobals,
  diff: ReturnType<typeof renderedDiff>,
  options: { maxParts?: number; budgetMs?: number; now?: () => number } = {},
): SourceAnalysis {
  const accounts = accountHunks(before, after, globals, diff, options);
  return {
    markers: accounts.flatMap((entry) => (entry.account === 'marker' ? [entry.marker] : [])),
    unchecked: accounts.filter((entry) => entry.account === 'unchecked').length,
  };
}
