import { parseMarkup } from '../markup/parse.js';
import type { MarkupLine } from '../markup/types.js';
import { prepareMarkup, markupConditions, markupCommentContext } from '../markup/prepare.js';
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
  refusalReason?: string;
  manualFixes?: { label: string; reason: string }[];
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
  if (retiredColours.includes(name)) fixes.push({
    id: 'to-yellow', label: 'Change to yellow', structural: false,
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
function placementCandidates(source: string): RetiredOccurrence[] {
  if (!quick.test(source) && !source.includes('/*')) return [];
  const context = markupCommentContext(source);
  const { text, offsets } = context;
  if (!quick.test(text)) return [];
  const found: RetiredOccurrence[] = [];
  const mapOccurrence = (item: RetiredOccurrence, positions = offsets) => {
    const from = positions[item.from]!;
    const to = positions[item.to - 1]! + 1;
    const token = source.slice(from, to);
    item.fixes = item.fixes.map((fix) => ({
      ...fix,
      edits: fix.edits.flatMap((edit) => {
        const editFrom = positions[edit.from] ?? source.length;
        const editTo = edit.to ? positions[edit.to - 1]! + 1 : 0;
        const insert = edit.insert;
        if (fix.id === 'to-yellow') return [{ from, to, insert }];
        if (item.kind === 'wrapper' || item.kind === 'marker') {
          // Delete only characters belonging to the token. Removed comments and supported
          // markers are absent from positions, so they cannot be consumed by an unwrap.
          const compact = positions.slice(item.from, item.to).map((at) => source[at]).join('');
          const content = item.kind === 'wrapper' ? wrapper.exec(compact)?.[2] : undefined;
          if (item.kind === 'wrapper' && content === undefined) return [];
          const contentAt = content === undefined ? -1
            : compact.indexOf(content, compact.indexOf(item.name) + item.name.length);
          const deleted = positions.slice(item.from, item.to).filter((_, index) =>
            contentAt < 0 || index < contentAt || index >= contentAt + content!.length);
          if (item.kind === 'marker') {
            const lineStart = from === 0 || source[from - 1] === '\n';
            const lineEnd = to === source.length || source[to] === '\n';
            if (lineStart && source[to] === ' ') deleted.push(to);
            else if (lineEnd && source[from - 1] === ' ') deleted.unshift(from - 1);
          }
          const edits: RetiredEdit[] = [];
          for (const at of deleted) {
            const previous = edits.at(-1);
            if (previous?.to === at) previous.to++;
            else edits.push({ from: at, to: at + 1, insert: '' });
          }
          return edits;
        }
        if (fix.id === 'rows-to-lines') {
          const block = source.slice(editFrom, editTo);
          const lines = block.split('\n');
          const edits: RetiredEdit[] = [{ from: editFrom, to: editFrom + lines[0]!.length + 1, insert: '' }];
          let at = editFrom + lines[0]!.length + 1;
          for (const row of lines.slice(1, -1)) {
            const next = tableRowToLine(row);
            let prefix = 0;
            while (prefix < row.length && prefix < next.length && row[prefix] === next[prefix]) prefix++;
            let suffix = 0;
            while (suffix < row.length - prefix && suffix < next.length - prefix
              && row[row.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
            if (row !== next) edits.push({
              from: at + prefix, to: at + row.length - suffix,
              insert: next.slice(prefix, next.length - suffix),
            });
            at += row.length + 1;
          }
          edits.push({ from: at - 1, to: editTo, insert: '' });
          return edits;
        }
        return [{ from: editFrom, to: editTo, insert }];
      }),
    }));
    found.push({ ...item, from, to, source: token });
  };
  for (const item of tableOccurrences(text, text))
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

/** Walk the actual parser output, including table rows, cells, and nested title bodies. */
function parserNames(lines: MarkupLine[]): string[] {
  const names: string[] = [];
  const classes = (values?: (string | undefined)[]) => {
    for (const name of values ?? [])
      if (name && (retiredMarkers.includes(name) || name === 'table')) names.push(name);
  };
  const spans = (values: NonNullable<MarkupLine['linesContent']>) => {
    for (const span of values) {
      classes(span.classNames);
      if (span.title) names.push(...parserNames(span.title));
    }
  };
  for (const line of lines) {
    classes(line.classNames);
    spans(line.linesContent ?? []);
    for (const row of line.table ?? []) {
      classes(row.classNames);
      for (const cell of row.rowContent ?? []) {
        classes(cell.classNames);
        spans(cell.cellContent);
      }
    }
  }
  return names;
}

function stripRetired(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(stripRetired);
    const merged: unknown[] = [];
    for (const item of items) {
      const previous = merged.at(-1);
      if (item && previous && typeof item === 'object' && typeof previous === 'object'
          && 'text' in item && 'text' in previous
          && typeof item.text === 'string' && typeof previous.text === 'string') {
        const { text: currentText, ...attributes } = item;
        const { text: previousText, ...previousAttributes } = previous;
        if (JSON.stringify(attributes) === JSON.stringify(previousAttributes)) {
          merged[merged.length - 1] = { text: previousText + currentText, ...attributes };
          continue;
        }
      }
      merged.push(item);
    }
    return merged;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, item]) => {
      if (key === 'classNames') {
        const classes = ((item ?? []) as (string | undefined)[]).filter(
          (name) => name && !retiredMarkers.includes(name),
        );
        return classes.length ? [[key, classes]] : [];
      }
      return item === undefined ? [] : [[key, stripRetired(item)]];
    }));
  }
  return value;
}

/** A structural comparison flattens rows to lines, while keeping cell text and styles. */
function normalizedLines(lines: MarkupLine[]): unknown {
  return lines.flatMap((line) => {
    if (!line.table) return [stripRetired(line)];
    return line.table.map((row) => ({
      classNames: (line.classNames ?? []).filter((name) => name !== 'table'),
      linesContent: (row.rowContent ?? []).flatMap((cell, index) => [
        ...(index ? [{ text: ' | ' }] : []),
        ...cell.cellContent.map((span) => ({
          ...span,
          classNames: [...(row.classNames ?? []), ...(cell.classNames ?? []), ...(span.classNames ?? [])],
        })),
      ]),
    })).map(stripRetired);
  });
}

function commentBytes(source: string): string[] {
  return markupCommentContext(source).comments.sort((a, b) => a.from - b.from)
    .map(({ from, to }) => source.slice(from, to));
}

/** Non-retired marker and wrapper openings must survive independently of rendered equivalence. */
function supportedTokens(source: string): string[] {
  return [...markupCommentContext(source).text.matchAll(/<([a-zA-Z]+)(\/?>|\s)?/g)]
    .filter((match) => !retiredMarkers.includes(match[1]!))
    .map((match) => match[0]);
}

function verifyFix(source: string, occurrence: RetiredOccurrence, fix: RetiredFix): string | undefined {
  const next = applyRetiredEdits(source, fix.edits);
  if (JSON.stringify(commentBytes(source)) !== JSON.stringify(commentBytes(next)))
    return 'The edit would change a source comment.';
  if (JSON.stringify(supportedTokens(source)) !== JSON.stringify(supportedTokens(next)))
    return 'The edit would change supported markup.';
  const type = markupConditions.find(([name]) => name === occurrence.name)?.[1];
  const before = parseMarkup(source, { variables: '', titles: '', type }).lines;
  const after = parseMarkup(next, { variables: '', titles: '', type }).lines;
  const normalize = fix.structural ? normalizedLines : stripRetired;
  if (JSON.stringify(stripRetired(normalize(before))) !== JSON.stringify(stripRetired(normalize(after))))
    return 'The parser cannot confirm unchanged text and supported styles.';
  if (next === source || parserNames(parseMarkup(next).lines).length >= parserNames(parseMarkup(source).lines).length
      && occurrence.kind !== 'condition')
    return 'The edit does not remove a retired parser finding.';
  return undefined;
}

/** Locate a containing source block without using its syntax as the detection predicate. */
function fallbackBlock(source: string, name: string, count: number): { from: number; to: number; source: string } {
  const { text, offsets } = markupCommentContext(source);
  const tables = [...text.matchAll(/< table [\s\S]*?\n<\$>/g)].map((match) => ({
    from: offsets[match.index!]!, to: offsets[match.index! + match[0].length - 1]! + 1,
  }));
  const blocks = [...tables];
  let at = 0;
  for (const line of source.split('\n')) {
    const to = at + line.length;
    if (!tables.some((table) => at < table.to && to > table.from)) blocks.push({ from: at, to });
    at = to + 1;
  }
  // Removing the block must remove a real parser finding. This also locates local variable
  // declarations and title bodies without a second implementation of their expansion rules.
  const block = blocks.find(({ from, to }) =>
    parserNames(parseMarkup(source.slice(0, from) + source.slice(to)).lines)
      .filter((value) => value === name).length < count,
  ) ?? blocks.find(({ from, to }) => source.slice(from, to).includes(name)) ?? blocks[0]
    ?? { from: 0, to: source.length };
  return { ...block, source: source.slice(block.from, block.to) };
}

/** Recognition comes exclusively from the production pipeline; regexes only place source edits. */
export function findRetiredMarkup(source: string): RetiredOccurrence[] {
  const names = parserNames(parseMarkup(source).lines);
  const candidates = placementCandidates(source);
  const found: RetiredOccurrence[] = [];
  for (const name of names) {
    const count = names.filter((value) => value === name).length;
    const index = candidates.findIndex((item) => item.name === name &&
      parserNames(parseMarkup(source.slice(0, item.from) + source.slice(item.to)).lines)
        .filter((value) => value === name).length < count);
    const candidate = index < 0 ? undefined : candidates.splice(index, 1)[0];
    found.push(candidate ?? {
      kind: name === 'table' ? 'table' : 'wrapper', name, token: noun(name),
      ...fallbackBlock(source, name, count),
      message: retired(noun(name), 'Fix by hand: an exact source token could not be mapped.'),
      fixes: [], refusalReason: 'An exact source token could not be mapped.',
    });
  }
  // Observe recognition in prepareMarkup itself: preceding condition removals can hide nested
  // blocks. Searching the raw source independently would incorrectly resurrect those blocks.
  prepareMarkup(source, { variables: '', titles: '' }, [], (name, block) => {
    if (name === 'enhanced') return;
    const from = source.indexOf(block);
    const mapped = from >= 0 && source.lastIndexOf(block) === from;
    const rangeFrom = Math.max(0, from);
    const end = from >= 0 ? from + block.length : Math.max(0, source.indexOf('\n'));
    const openEnd = from + block.indexOf('\n');
    const closeFrom = from + block.lastIndexOf('\n');
    found.push({
      kind: 'condition', name, token: `${name} ( … )`, source: source.slice(rangeFrom, end),
      from: rangeFrom, to: end,
      message: retired(`${name} ( … )`, 'Keep its contents, or fix by hand.'),
      fixes: mapped ? [{ id: 'keep-contents', label: 'Keep contents', structural: true, edits: [
        { from, to: openEnd + 1, insert: '' }, { from: closeFrom, to: end, insert: '' },
      ] }] : [],
    });
  });
  for (const occurrence of found) {
    let reason = occurrence.refusalReason;
    occurrence.fixes = occurrence.fixes.filter((fix) => {
      const blockFrom = Math.min(occurrence.from, ...fix.edits.map((edit) => edit.from));
      const blockEnd = Math.max(occurrence.to, ...fix.edits.map((edit) => edit.to));
      const newline = source.indexOf('\n', blockEnd);
      const blockTo = newline < 0 ? source.length : newline;
      const refusal = fix.structural && markupCommentContext(source).comments.some(
        (comment) => comment.from < blockTo && comment.to > blockFrom,
      )
        ? 'Blocks containing comments must be fixed by hand.'
        : verifyFix(source, occurrence, fix);
      if (refusal) {
        reason = refusal;
        (occurrence.manualFixes ??= []).push({ label: fix.label, reason: refusal });
      }
      return !refusal;
    });
    if (!occurrence.fixes.length) {
      occurrence.refusalReason = reason ?? 'A lossless source edit could not be verified.';
      occurrence.message = retired(occurrence.token, `Fix by hand: ${occurrence.refusalReason}`);
    }
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
    const next = found.find((occurrence) => occurrence.fixes[0] && !occurrence.fixes[0].structural);
    if (!next) return { text, fixed, remaining: found.length };
    text = applyRetiredEdits(text, next.fixes[0]!.edits);
    fixed++;
  }
}
