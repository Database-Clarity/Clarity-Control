import { markupInlineRanges } from '../markup/lines.js';
import { markupCommentContext } from '../markup/prepare.js';
import { variableReferencePattern } from '../markup/braces.js';
import { markupColors } from '../markup/syntax.js';
import { elementTagToken } from '../markup/elementTags.js';

const wrappers = new Set([...markupColors, 'background', 'link', 'title']);
/** Preserve source offsets and barriers: a tag never joins two halves of a term. */
export function glossaryProse(source: string): string {
  const chars = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  for (const range of markupCommentContext(source).comments) blank(range.from, range.to);
  let offset = 0;
  for (const line of chars.join('').split('\n')) {
    if (
      line.trimStart().startsWith('< table ') ||
      line.trim() === '<$>' ||
      /^[ \t]*(?:var\s|import\s|(?:export(?:\s+hidden)?|title)\s.*\(\s*$|(?:enhanced|catalyst|exotic perk)\s*\(\s*$|\)\s*$)/.test(
        line,
      )
    ) {
      blank(offset, offset + line.length);
    } else {
      for (const { from, to } of markupInlineRanges(line)) {
        const token = line.slice(from, to);
        const tag = /^<(\w+) /.exec(token);
        if (tag && (wrappers.has(tag[1]!) || elementTagToken(token))) {
          blank(offset + from, offset + from + tag[0].length);
          const labelEnd =
            tag[1] === 'link' || tag[1] === 'title' ? token.search(/ \[.*\] \/>$/) : -1;
          blank(offset + from + (labelEnd < 0 ? token.length - 3 : labelEnd), offset + to);
          for (const icon of token.matchAll(/<arrow\/>/g))
            blank(offset + from + icon.index, offset + from + icon.index + icon[0].length);
        } else blank(offset + from, offset + to);
      }
      for (const match of line.matchAll(variableReferencePattern))
        blank(offset + match.index, offset + match.index + match[0].length);
      for (const match of line.matchAll(/\$\{[^}\n]*\}|\d+(?:[.,]\d+)?/g))
        blank(offset + match.index, offset + match.index + match[0].length);
    }
    offset += line.length + 1;
  }
  return chars.join('');
}

export function glossaryTermUsed(
  prose: string,
  entry: { term: string; forms?: readonly string[] },
): boolean {
  const text = prose.normalize('NFKC').toLowerCase();
  return [entry.term, ...(entry.forms ?? [])].some((form) =>
    text.includes(form.normalize('NFKC').toLowerCase()),
  );
}
