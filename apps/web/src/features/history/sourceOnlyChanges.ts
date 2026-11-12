import {
  markupCommentContext,
  markupDefinitions,
  parseMarkup,
  scanBaseEnhanced,
  type MarkupGlobals,
} from '@clarity/core';
import {
  markupConditionMatches,
  markupConditions,
} from '../../../../../packages/core/src/markup/prepare';
import { diffWords } from '../../ui/diff/diffWords';

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

function sourceParts(before: string, after: string): Part[] {
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

/** Worker-only, bounded counterfactuals; never changes parser or renderer output. */
export function analyzeSourceOnly(
  before: string,
  after: string,
  globals: MarkupGlobals,
  options: { maxParts?: number; budgetMs?: number; now?: () => number } = {},
): SourceAnalysis {
  const now = options.now ?? (() => performance.now()),
    start = now();
  const parts = sourceParts(before, after),
    markers: SourceMarker[] = [];
  const original = JSON.stringify(parseMarkup(before, globals).lines);
  const renderedCount = parseMarkup(after, globals).lines.length;
  const line = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
  const startLine = (text: string, offset: number) =>
    line(text, offset) + (text[offset] === '\n' ? 1 : 0);
  const range = (text: string, from: number, to: number) =>
    from === to
      ? `at line ${line(text, from)}`
      : startLine(text, from) === line(text, Math.max(from, to - 1))
        ? `line ${startLine(text, from)}`
        : `lines ${startLine(text, from)}–${line(text, to - 1)}`;
  let checked = 0;
  for (const part of parts) {
    if (checked >= (options.maxParts ?? 40) || now() - start >= (options.budgetMs ?? 50)) break;
    const alone =
      before.slice(0, part.from) + after.slice(part.nextFrom, part.nextTo) + before.slice(part.to);
    if (JSON.stringify(parseMarkup(alone, globals).lines) === original) {
      const position = Math.min(
        renderedCount,
        Math.max(0, parseMarkup(after.slice(0, part.nextFrom), globals).lines.length),
      );
      markers.push({
        position,
        label: `Markup-only change · ${part.kind} · previous ${before ? range(before, part.from, part.to) : 'not present'}; current ${after ? range(after, part.nextFrom, part.nextTo) : 'not present'}. Not shown in this rendered view; inspect Raw.`,
      });
    }
    checked++;
  }
  return { markers, unchecked: parts.length - checked };
}
