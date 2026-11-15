import { variableReferences } from './braces.js';
import { markupInlineRanges } from './lines.js';
import { markupCommentContext } from './prepare.js';
import { scanBaseEnhanced } from './baseEnhanced.js';

export type NumberKind = 'N' | 'S' | 'M';
export interface NumberSlot {
  kind: NumberKind;
  value: string;
  from: number;
  to: number;
  /** Zero-based source line, and the masked enclosing block, heading, and inline arm. */
  line: number;
  scope: string;
}
export interface NumberRange {
  from: number;
  to: number;
}

const digits = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\??`;
const number = new RegExp(`[-+]?${digits}`, 'y');
const stack = new RegExp(`[-+]?${digits}%?(?: ?\\| ?(?:${digits}%?|…|\\.\\.\\.|\\?))+`, 'y');
const unitAfter = /^(?:%|x\b|×|ms\b|s\b|m\b|HP\b|hp\b|k\b|\+|[^\p{L}\p{N}_]|$)/u;
const contains = (range: NumberRange, at: number) => at >= range.from && at < range.to;

/** Preserve source offsets and line boundaries while removing the core's comment ranges. */
export function numberProse(text: string): string {
  const chars = text.split('');
  for (const { from, to } of markupCommentContext(text).comments)
    for (let at = from; at < to; at++) if (chars[at] !== '\n') chars[at] = ' ';
  return chars.join('').replace(/\r/g, ' ');
}

/** Maths is one span, including delimited variables' inner braces. */
export function numberMathRanges(text: string): NumberRange[] {
  const refs = new Map(variableReferences(text).map((ref) => [ref.from, ref.to]));
  const ranges: NumberRange[] = [];
  for (let from = text.indexOf('${'); from >= 0; from = text.indexOf('${', from + 2)) {
    let at = from + 2;
    for (; at < text.length && text[at] !== '\n' && text[at] !== '}'; at++) {
      const end = refs.get(at);
      if (end !== undefined) at = end - 1;
      else if (text.startsWith('#{=', at)) {
        const end = text.indexOf('}', at + 3);
        if (end >= 0) at = end;
      }
    }
    if (text[at] === '}') ranges.push({ from, to: at + 1 });
  }
  return ranges;
}

/** The parser's inline ranges identify targets; labels remain translated prose. */
export function numberTargetRanges(line: string): NumberRange[] {
  return markupInlineRanges(line).flatMap((range) => {
    const token = line.slice(range.from, range.to);
    if (!/^<(?:link|title|formula) /.test(token)) return [];
    const target = /\[.+\]/.exec(token);
    return target
      ? [{ from: range.from + target.index, to: range.from + target.index + target[0].length }]
      : [];
  });
}

export const numberBlockOpen =
  /^(?:(?:title|export)\b.*\(|(?:enhanced|catalyst|exotic perk) \()\s*$/;
const heading = (line: string) => /^<\s.*>\s*$/.test(line) || /:\s*$/.test(line);

/** Exact source bytes, with each quantity replaced by its typed marker. */
export function numberTemplate(text: string, slots = numberSlots(text)): string {
  let result = '',
    at = 0;
  for (const slot of slots) {
    result += text.slice(at, slot.from).replaceAll('\u001f', '\u001f\u001f') + '\u001f' + slot.kind;
    at = slot.to;
  }
  return result + text.slice(at).replaceAll('\u001f', '\u001f\u001f');
}

/** English only. Reserved global documents are declaration libraries, never token sources. */
export function numberSlots(text: string, hash?: number): NumberSlot[] {
  if (hash !== undefined && hash >= 1 && hash <= 3) return [];
  const prose = numberProse(text);
  const slots: NumberSlot[] = [];
  let offset = 0,
    inTable = false;
  let block = '',
    nearestHeading = '';
  const parents: { block: string; heading: string }[] = [];
  for (const [lineNo, line] of prose.split('\n').entries()) {
    const base = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (numberBlockOpen.test(trimmed)) {
      parents.push({ block, heading: nearestHeading });
      block = trimmed.toLowerCase().replace(/\s+/g, ' ');
      nearestHeading = '';
      continue;
    }
    if (/^\)\s*$/.test(trimmed)) {
      const parent = parents.pop();
      block = parent?.block ?? '';
      nearestHeading = parent?.heading ?? '';
      continue;
    }
    if (/^< table\b/.test(trimmed)) inTable = true;
    if (/^<\$>/.test(trimmed)) {
      inTable = false;
      continue;
    }
    if (/^import\b/.test(trimmed) || /^<\$\$>/.test(trimmed) || /^<\/weapons\b/.test(trimmed))
      continue;
    const isHeading = heading(trimmed);
    const scope = JSON.stringify([block, nearestHeading]);
    // Structural headings contain names, not quantities; ordinary colon headings are prose.
    const skip = /^<\s.*>\s*$/.test(trimmed);
    const excluded = [...variableReferences(line), ...numberTargetRanges(line)];
    for (const tag of line.matchAll(/<\/?[a-zA-Z_]+[0-9]*(?=[\s/>])/g))
      excluded.push({ from: tag.index, to: tag.index + tag[0].length });
    if (inTable)
      for (const mod of line.matchAll(/\|[bchr\d-]+/g))
        excluded.push({ from: mod.index, to: mod.index + mod[0].length });
    const math = new Map(numberMathRanges(line).map((range) => [range.from, range.to]));
    const pairs = scanBaseEnhanced(line).pairs;
    const inline = markupInlineRanges(line).filter((range) =>
      /^<pv[ep] /.test(line.slice(range.from, range.to)),
    );
    const start = /^\s*var [a-zA-Z0-9]+ = /.exec(line)?.[0].length ?? 0;
    const lineStart = slots.length;
    for (let at = start; !skip && at < line.length;) {
      if (excluded.some((range) => contains(range, at))) {
        at++;
        continue;
      }
      let kind: NumberKind = 'N',
        to = math.get(at);
      if (to !== undefined) kind = 'M';
      else {
        const previous = line[at - 1] ?? '';
        const before = line[at - 2] ?? '';
        if (
          !/[0-9+-]/.test(line[at]) ||
          (/[\p{L}\p{N}_.#]/u.test(previous) &&
            !(previous === 'x' && !/[\p{L}\p{N}_]/u.test(before)))
        ) {
          at++;
          continue;
        }
        stack.lastIndex = number.lastIndex = at;
        const stacked = inTable ? null : stack.exec(line);
        const match = stacked ?? number.exec(line);
        if (!match) {
          at++;
          continue;
        }
        to = at + match[0].length;
        if (
          !unitAfter.test(line.slice(to)) ||
          (line[to] === '.' && /\d/.test(line[to + 1] ?? ''))
        ) {
          at = to;
          continue;
        }
        if (stacked) kind = 'S';
      }
      let arm = '';
      for (const range of inline)
        if (contains(range, at)) arm += line.slice(range.from + 1, range.from + 4);
      for (const pair of pairs)
        if (contains(pair, at))
          arm += at < pair.from + 2 + pair.base.length ? '/base' : '/enhanced';
      if (inTable) arm += `/cell${line.slice(0, at).split('|').length - 1}`;
      slots.push({
        kind,
        value: text.slice(base + at, base + to),
        from: base + at,
        to: base + to,
        line: lineNo,
        scope: scope + arm,
      });
      at = to;
    }
    if (isHeading) {
      const local = slots
        .slice(lineStart)
        .map((slot) => ({ ...slot, from: slot.from - base, to: slot.to - base }));
      nearestHeading = numberTemplate(line, local).toLowerCase().replace(/\s+/g, ' ').trim();
    }
  }
  return slots;
}
