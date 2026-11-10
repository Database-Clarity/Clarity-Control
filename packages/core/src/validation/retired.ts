import { markupCommentContext } from '../markup/prepare.js';
import {
  markupLineClasses,
  markupRetiredColors,
  markupRetiredLineStyles,
} from '../markup/syntax.js';

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
const retiredWrappers = [...retiredColours, 'center', 'background', 'breakSpaces'];
const retiredMarkers = [...retiredColours, ...markupRetiredLineStyles];

const quick =
  /(?:blue|green|purple|center|breakSpaces|background)\b|^(?:catalyst|exotic perk) \(|^< table /m;
/** The converter's tokenizer: a token runs from a `<` to the first `/>` after it, per line. */
const converterToken = /<.+?\/>/g;
const marker = new RegExp(`^<(${retiredMarkers.join('|')})\\s*/>$`);
const wrapper = new RegExp(`^<(${retiredWrappers.join('|')})\\s+([\\s\\S]*?)\\s*/>$`);
const conditions = ['catalyst', 'exotic perk'];

const noun = (name: string) => `<${name} … />`;
const retired = (token: string, advice: string) =>
  `Retired markup ${token}: no longer supported. ${advice}`;

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
  sourceToken = token,
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
  const inner = wrapper.exec(sourceToken)?.[2] ?? wrapped[2]!;
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

function conditionOccurrences(text: string, source: string): RetiredOccurrence[] {
  const found: RetiredOccurrence[] = [];
  for (const name of conditions) {
    // The same block pattern the converter uses (prepare.ts).
    for (const match of text.matchAll(new RegExp(`^${name} \\([\\s\\S]*?\\n\\) *$`, 'gm'))) {
      const closingFrom = match.index + match[0].lastIndexOf('\n') + 1;
      if (
        markupCommentContext(source.slice(closingFrom, match.index + match[0].length)).text !== ')'
      )
        continue;
      const from = match.index;
      const end = from + match[0].length;
      const lines = source.slice(from, end).split('\n');
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

function tableOccurrences(text: string, source: string): RetiredOccurrence[] {
  const found: RetiredOccurrence[] = [];
  for (const match of text.matchAll(/^< table [^\n]*\n[\s\S]*?\n<\$>$/gm)) {
    const from = match.index;
    const rows = source.slice(from, from + match[0].length).split('\n');
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

/** Every retired form in the text, with edits mapped back to the authored source. */
export function findRetiredMarkup(source: string): RetiredOccurrence[] {
  if (!quick.test(source) && !source.includes('/*')) return [];
  const context = markupCommentContext(source);
  const { text, offsets } = context;
  if (!quick.test(text)) return [];
  const found: RetiredOccurrence[] = [];
  const mapOccurrence = (item: RetiredOccurrence, positions = offsets) => {
    const from = positions[item.from]!;
    const to = positions[item.to - 1]! + 1;
    const token = source.slice(from, to);
    const comments = context.comments.filter((comment) => comment.from >= from && comment.to <= to);
    const preservedComments = comments
      .map((comment) => source.slice(comment.from, comment.to))
      .join('');
    item.fixes = item.fixes.map((fix) => ({
      ...fix,
      edits: fix.edits.map((edit) => {
        let editFrom = positions[edit.from] ?? source.length;
        let editTo = edit.to ? positions[edit.to - 1]! + 1 : 0;
        let insert = edit.insert;
        if (item.kind === 'marker') {
          // Neighbour removal must inspect actual source characters, never deleted comments.
          const lineStart = from === 0 || source[from - 1] === '\n';
          const lineEnd = to === source.length || source[to] === '\n';
          editFrom = lineEnd && source[from - 1] === ' ' ? from - 1 : from;
          editTo = lineStart && source[to] === ' ' ? to + 1 : to;
          insert = preservedComments;
        } else if (item.kind === 'wrapper') {
          const compact = positions
            .slice(item.from, item.to)
            .map((position) => source[position])
            .join('');
          const content = wrapper.exec(compact)?.[2] ?? '';
          const contentAt = compact.indexOf(content, compact.indexOf(item.name) + item.name.length);
          const contentFrom = positions[item.from + contentAt] ?? to;
          const contentTo = content.length
            ? positions[item.from + contentAt + content.length - 1]! + 1
            : contentFrom;
          // Keep every authored comment, including comments splitting the tag name or padding.
          const before = comments
            .filter((comment) => comment.to <= contentFrom)
            .map((comment) => source.slice(comment.from, comment.to))
            .join('');
          const after = comments
            .filter((comment) => comment.from >= contentTo)
            .map((comment) => source.slice(comment.from, comment.to))
            .join('');
          const inner =
            (before && content ? before + ' ' : before) +
            source.slice(contentFrom, contentTo) +
            after;
          insert = fix.id === 'to-yellow' ? `<yellow ${inner} />` : inner;
        } else if (fix.id === 'keep-contents' || fix.id === 'rows-to-lines') {
          const original = source.slice(editFrom, editTo).split('\n');
          const rows = original.slice(1, -1);
          insert =
            fix.id === 'keep-contents' ? rows.join('\n') : rows.map(tableRowToLine).join('\n');
        }
        return { from: editFrom, to: editTo, insert };
      }),
    }));
    found.push({ ...item, from, to, source: token });
  };
  for (const item of [...conditionOccurrences(text, text), ...tableOccurrences(text, text)])
    mapOccurrence(item);
  let lineFrom = 0;
  for (const line of text.split('\n')) {
    let clean = line;
    const positions = offsets.slice(lineFrom, lineFrom + line.length);
    // The parser removes the first exact marker of each name before tokenizing spans.
    for (const name of markupLineClasses) {
      const token = `<${name}/>`;
      const index = clean.indexOf(token);
      if (index !== -1) {
        if (retiredMarkers.includes(name))
          mapOccurrence(tokenOccurrence(token, clean, 0, index)!, positions);
        clean = clean.slice(0, index) + clean.slice(index + token.length);
        positions.splice(index, token.length);
      }
    }
    for (const match of clean.matchAll(converterToken)) {
      const item = tokenOccurrence(match[0], clean, 0, match.index);
      if (item) mapOccurrence(item, positions);
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
