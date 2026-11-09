import { markupCommentContext } from '../markup/prepare.js';
import { markupRetiredColors, markupRetiredLineStyles } from '../markup/syntax.js';

/**
 * Retired markup (owner 2026-11-09): the colours blue, green, and purple, the line styles centre,
 * break-spaces, and background, the catalyst and exotic-perk condition blocks, and tables. The
 * parser still accepts all of them (so old text renders as it always did); this module only finds
 * them, words the warning, and builds the one-click fixes. Yellow and bold stay.
 */
export type RetiredKind = 'wrapper' | 'marker' | 'condition' | 'table';
export type RetiredFixId =
  'remove-tag' | 'to-yellow' | 'remove-marker' | 'remove-block' | 'keep-contents' | 'rows-to-lines';

export interface RetiredEdit {
  from: number;
  to: number;
  insert: string;
}

export interface RetiredFix {
  id: RetiredFixId;
  label: string;
  /** Rewrites more than one tag, so the editor previews the result before applying it. */
  structural: boolean;
  edits: RetiredEdit[];
}

export interface RetiredOccurrence {
  kind: RetiredKind;
  /** The retired name: `blue`, `center`, `catalyst`, `table`, … */
  name: string;
  /** How the form reads in the warning: `<blue … />`, `<blue/>`, `catalyst ( … )`, `< table … >`. */
  token: string;
  /** The text as written (`<blue Solar Fulmination />`, `catalyst (`), for telling occurrences apart. */
  source: string;
  /** What the editor underlines: the whole token, or the first line of a block. */
  from: number;
  to: number;
  message: string;
  /** In the concept's order: the first one is what Fix all applies. */
  fixes: RetiredFix[];
}

const retiredColours = markupRetiredColors;
const retiredWrappers = [...retiredColours, 'center', 'background'];
const retiredMarkers = [...retiredColours, ...markupRetiredLineStyles];

const quick =
  /<(?:blue|green|purple|center|breakSpaces|background)\b|^(?:catalyst|exotic perk) \(|^< table /m;
/** The converter's tokenizer: a token runs from a `<` to the first `/>` after it, per line. */
const converterToken = /<.+?\/>/g;
const marker = new RegExp(`^<(${retiredMarkers.join('|')})\\s*/>$`);
const wrapper = new RegExp(`^<(${retiredWrappers.join('|')})\\s+([\\s\\S]*?)\\s*/>$`);
const conditions = ['catalyst', 'exotic perk'];

const noun = (name: string) => `<${name} … />`;
const retired = (token: string, advice: string) =>
  `Retired markup ${token}: no longer supported. ${advice}`;

/** Comments never reach the exporter, so they are blanked (offsets and line breaks stay). */
function withoutComments(text: string): string {
  const { comments } = markupCommentContext(text);
  if (!comments.length) return text;
  let masked = '';
  let last = 0;
  // Block and line comments are collected separately, so they arrive out of order.
  for (const { from, to } of [...comments].sort((a, b) => a.from - b.from)) {
    if (from < last) continue;
    masked += text.slice(last, from) + text.slice(from, to).replace(/[^\n]/g, ' ');
    last = to;
  }
  return masked + text.slice(last);
}

/** A removed line marker also takes one neighbouring space, so no stray gap is left behind. */
function markerEdit(line: string, lineFrom: number, from: number, to: number): RetiredEdit {
  const start = from - lineFrom;
  const end = to - lineFrom;
  if (line[end] === ' ' && start === 0) return { from, to: to + 1, insert: '' };
  if (start > 0 && line[start - 1] === ' ' && end === line.length)
    return { from: from - 1, to, insert: '' };
  return { from, to, insert: '' };
}

function tokenOccurrence(
  token: string,
  line: string,
  lineFrom: number,
  from: number,
): RetiredOccurrence | null {
  const to = from + token.length;
  const bare = marker.exec(token);
  if (bare) {
    const name = bare[1]!;
    return {
      kind: 'marker',
      name,
      token: `<${name}/>`,
      source: token,
      from,
      to,
      message: retired(`<${name}/>`, 'Remove the marker.'),
      fixes: [
        {
          id: 'remove-marker',
          label: 'Remove marker',
          structural: false,
          edits: [markerEdit(line, lineFrom, from, to)],
        },
      ],
    };
  }
  const wrapped = wrapper.exec(token);
  if (!wrapped) return null;
  const name = wrapped[1]!;
  const inner = wrapped[2]!;
  const fixes: RetiredFix[] = [
    {
      id: 'remove-tag',
      label: 'Remove tag (keep the text)',
      structural: false,
      edits: [{ from, to, insert: inner }],
    },
  ];
  if (retiredColours.includes(name))
    fixes.push({
      id: 'to-yellow',
      label: 'Change to yellow',
      structural: false,
      edits: [{ from, to, insert: `<yellow ${inner} />` }],
    });
  return {
    kind: 'wrapper',
    name,
    token: noun(name),
    source: token,
    from,
    to,
    message: retired(
      noun(name),
      retiredColours.includes(name)
        ? 'Remove the tag (the text stays) or change it to <yellow … />.'
        : 'Remove the tag (the text stays).',
    ),
    fixes,
  };
}

function conditionOccurrences(text: string): RetiredOccurrence[] {
  const found: RetiredOccurrence[] = [];
  for (const name of conditions) {
    // The same block pattern the converter uses (prepare.ts).
    for (const match of text.matchAll(new RegExp(`^${name} \\([\\s\\S]*?\\n\\)$`, 'gm'))) {
      const from = match.index;
      const end = from + match[0].length;
      const lines = match[0].split('\n');
      const contents = lines.slice(1, -1).join('\n');
      // Dropping the block drops its line break too; the last line of the text takes the one before.
      const gone: RetiredEdit =
        text[end] === '\n'
          ? { from, to: end + 1, insert: '' }
          : from > 0
            ? { from: from - 1, to: end, insert: '' }
            : { from, to: end, insert: '' };
      found.push({
        kind: 'condition',
        name,
        token: `${name} ( … )`,
        source: lines[0]!,
        from,
        to: from + lines[0]!.length,
        message: retired(`${name} ( … )`, 'Remove the block or keep its contents.'),
        fixes: [
          { id: 'remove-block', label: 'Remove block', structural: true, edits: [gone] },
          {
            id: 'keep-contents',
            label: 'Keep contents',
            structural: true,
            edits: [{ from, to: end, insert: contents }],
          },
        ],
      });
    }
  }
  return found;
}

function tableRowToLine(row: string): string {
  const cells = row.match(/\|.*?((?=\|)|$)/g);
  if (!cells) return row;
  // The same cell and flag reading as the converter: `|bc 2` is flags b, c, then the content.
  return cells
    .map((cell) => cell.replace(/^\|[bchr\d-]+|^\|/, '').trim())
    .filter(Boolean)
    .join(' | ');
}

function tableOccurrences(text: string): RetiredOccurrence[] {
  const found: RetiredOccurrence[] = [];
  for (const match of text.matchAll(/^< table [^\n]*\n[\s\S]*?\n<\$>$/gm)) {
    const from = match.index;
    const rows = match[0].split('\n');
    const lines = rows.slice(1, -1).map(tableRowToLine).join('\n');
    found.push({
      kind: 'table',
      name: 'table',
      token: '< table … >',
      source: rows[0]!,
      from,
      to: from + rows[0]!.length,
      message: retired('< table … >', 'Convert the rows to lines.'),
      fixes: [
        {
          id: 'rows-to-lines',
          label: 'Convert rows to lines',
          structural: true,
          edits: [{ from, to: from + match[0].length, insert: lines }],
        },
      ],
    });
  }
  return found;
}

/** Every retired form in the text, in document order. Fixes are exact edits on this text. */
export function findRetiredMarkup(source: string): RetiredOccurrence[] {
  if (!quick.test(source)) return [];
  const text = withoutComments(source);
  const found: RetiredOccurrence[] = [...conditionOccurrences(text), ...tableOccurrences(text)];
  let lineFrom = 0;
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(converterToken)) {
      const occurrence = tokenOccurrence(match[0], line, lineFrom, lineFrom + match.index);
      if (occurrence) found.push(occurrence);
    }
    lineFrom += line.length + 1;
  }
  return found.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The warning `validateText` raises for each retired form (P0b raises it to an error). */
export function retiredWarnings(text: string) {
  return findRetiredMarkup(text).map(({ from, to, message }) => ({ from, to, message }));
}

export function applyRetiredEdits(text: string, edits: readonly RetiredEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from))
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}

/**
 * Fix all: the first fix of every form that rewrites only itself. Structural forms (blocks and
 * tables) stay for the author to preview one by one. Running it again changes nothing.
 */
export function fixAllRetired(
  text: string,
  /** Lets a caller hide text that is not its own (a conflict's "theirs") from the search. */
  find: (text: string) => RetiredOccurrence[] = findRetiredMarkup,
): { text: string; fixed: number; remaining: number } {
  let fixed = 0;
  // One form at a time on the fresh text: neighbouring markers share a space, so edits computed
  // together could overlap. Each pass removes one form, so the loop always ends.
  for (;;) {
    const found = find(text);
    const next = found.find((occurrence) => !occurrence.fixes[0]!.structural);
    if (!next) return { text, fixed, remaining: found.length };
    text = applyRetiredEdits(text, next.fixes[0]!.edits);
    fixed++;
  }
}
