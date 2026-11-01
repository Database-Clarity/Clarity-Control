import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  extractBlocks,
  extractVariables,
  markupColors,
  markupCommentContext,
  markupEmpty,
  markupIcons,
  markupImports,
  markupInlineRanges,
  markupLineClasses,
  markupTableClasses,
  markupVariableReferences,
  type MarkupGlobals,
} from '@clarity/core';

type MarkupKind = 'inline' | 'icon' | 'line' | 'link' | 'title' | 'table';
export interface MarkupOption {
  id: string;
  label: string;
  group: string;
  kind: MarkupKind;
  name: string;
}

export const markupOptions: MarkupOption[] = [
  ...[...markupColors, 'background'].map((name) => ({
    id: `inline:${name}`,
    label: name,
    group: 'Inline format',
    kind: 'inline' as const,
    name,
  })),
  ...markupIcons.map((name) => ({
    id: `icon:${name}`,
    label: name,
    group: 'Icon',
    kind: 'icon' as const,
    name,
  })),
  ...[...new Set(markupLineClasses)].map((name) => ({
    id: `line:${name}`,
    label: name,
    group: 'Line style',
    kind: 'line' as const,
    name,
  })),
  ...markupTableClasses.map((name) => ({
    id: `table:${name}`,
    label: name,
    group: 'Table',
    kind: 'table' as const,
    name,
  })),
  { id: 'link', label: 'link', group: 'Reference', kind: 'link', name: 'link' },
  { id: 'title', label: 'title', group: 'Reference', kind: 'title', name: 'title' },
];

interface ProtectedRange {
  from: number;
  to: number;
  incomplete?: boolean;
  protectStart?: boolean;
  protectEnd?: boolean;
}

type Rejection = 'context' | 'expansion' | 'table-link' | 'line-style';
type PreparedContext = { text: string; offsets: number[] };

function expandedContext(text: string, globals: MarkupGlobals): PreparedContext | null {
  let expanded = text;
  let offsets = Array.from({ length: text.length }, (_, index) => index);
  const replace = (from: number, length: number, value: string) => {
    const origin = offsets[from];
    expanded = expanded.slice(0, from) + value + expanded.slice(from + length);
    offsets = offsets
      .slice(0, from)
      .concat(Array<number>(value.length).fill(origin), offsets.slice(from + length));
  };
  const structural = /[<>\r\n#${}|]|\/\*|\*\//;
  for (let pass = 0; pass < 5; pass++) {
    const imports = markupImports(expanded);
    if (!imports.length) break;
    for (const line of imports) {
      const match = line.match(/^import (.+?) from (\d+|global) *$/);
      if (!match) return null;
      const [, name, from] = match;
      const source =
        globals.imports?.[from] ?? (from === 'global' ? globals.imports?.['1'] : undefined);
      const value =
        name === 'main' || name === 'secondary'
          ? source
          : extractBlocks(source ?? '', 'export')[name];
      if (value === undefined || structural.test(value)) return null;
      replace(expanded.indexOf(line), line.length, value);
    }
  }
  if (markupImports(expanded).length) return null;
  for (const reference of markupVariableReferences(expanded)) {
    const variables = { ...extractVariables(expanded), ...extractVariables(globals.variables) };
    const value = variables[reference.slice(1)];
    if (value === undefined || structural.test(value)) return null;
    let from = expanded.indexOf(reference);
    while (from !== -1) {
      replace(from, reference.length, value);
      from = expanded.indexOf(reference, from + value.length);
    }
  }
  const originalComments = markupCommentContext(text).comments;
  const prepared = markupCommentContext(expanded);
  const expandedComments = prepared.comments.map(({ from, to }) => ({
    from: offsets[from],
    to: offsets[to - 1] + 1,
  }));
  const delimiters = (value: string, mapping: number[]) =>
    [...value.matchAll(/\/\*|\*\//g)].map((match) => ({
      from: mapping[match.index],
      to: mapping[match.index + 1] + 1,
    }));
  const originalDelimiters = delimiters(
    text,
    Array.from({ length: text.length }, (_, index) => index),
  );
  const expandedDelimiters = delimiters(expanded, offsets);
  const unsafe =
    originalComments.length !== expandedComments.length ||
    originalComments.some(
      (comment, index) =>
        comment.from !== expandedComments[index].from || comment.to !== expandedComments[index].to,
    ) ||
    originalDelimiters.length !== expandedDelimiters.length ||
    originalDelimiters.some(
      (delimiter, index) =>
        delimiter.from !== expandedDelimiters[index].from ||
        delimiter.to !== expandedDelimiters[index].to,
    );
  return unsafe
    ? null
    : { text: prepared.text, offsets: prepared.offsets.map((offset) => offsets[offset]) };
}

function protectedRanges(state: EditorState, comments: { from: number; to: number }[]) {
  const text = state.doc.toString();
  const tokens: ProtectedRange[] = [];
  const tables: ProtectedRange[] = [];
  for (const comment of comments) {
    const start = state.doc.lineAt(comment.from);
    const standalone = comment.from === start.from && text[comment.to - 1] === '\n';
    tokens.push({
      from: start.from,
      to: state.doc.lineAt(standalone ? comment.to - 1 : comment.to).to,
      protectStart: true,
      incomplete: true,
    });
  }
  let tableStart: number | undefined;
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (
      /^(?:title |export |var |import |enhanced \(|catalyst \(|exotic perk \()/.test(line.text) ||
      /^\) *$/.test(line.text)
    ) {
      tokens.push({ from: line.from, to: line.to, protectStart: true, protectEnd: true });
    }
    for (const range of markupInlineRanges(line.text)) {
      tokens.push({ from: line.from + range.from, to: line.from + range.to });
    }
    for (const match of line.text.matchAll(/<[^>\n]*(?:>|$)/g)) {
      tokens.push({
        from: line.from + match.index,
        to: line.from + match.index + match[0].length,
        incomplete: !match[0].endsWith('>'),
        protectStart: match[0].startsWith('< table ') || match[0] === '<$>',
        protectEnd: match[0].startsWith('< table ') || match[0] === '<$>',
      });
    }
    for (const match of line.text.matchAll(/<(\w+) /g)) {
      if (
        [...markupColors, 'background', 'link', 'title'].includes(match[1]) &&
        !line.text.includes('/>', match.index)
      ) {
        tokens.push({ from: line.from + match.index, to: line.to, incomplete: true });
      }
    }
    if (/#[a-zA-Z0-9]+|\$\{[^}\n]*(?:}|$)/.test(line.text)) {
      tokens.push({
        from: line.from,
        to: line.to,
        protectStart: true,
        incomplete: true,
      });
    }
    if (line.text.startsWith('< table ') && tableStart === undefined) tableStart = line.from;
    if (tableStart !== undefined) {
      for (const match of line.text.matchAll(/\|[bchr\d-]*/g)) {
        tokens.push({
          from: line.from + match.index,
          to: line.from + match.index + match[0].length,
          protectStart: true,
        });
      }
      if (line.text === '<$>') {
        tables.push({ from: tableStart, to: line.to });
        tableStart = undefined;
      }
    }
  }
  if (tableStart !== undefined)
    tables.push({ from: tableStart, to: text.length, incomplete: true });
  return { tokens, tables };
}

function intersects(from: number, to: number, protectedRange: ProtectedRange) {
  if (from === to) {
    return (
      (from > protectedRange.from ||
        (protectedRange.protectStart && from === protectedRange.from)) &&
      (from < protectedRange.to ||
        ((protectedRange.incomplete || protectedRange.protectEnd) && from === protectedRange.to))
    );
  }
  return (
    (from < protectedRange.to && to > protectedRange.from) ||
    (protectedRange.protectStart && to === protectedRange.from) ||
    ((protectedRange.incomplete || protectedRange.protectEnd) && from === protectedRange.to)
  );
}

function createMarkupTransaction(
  state: EditorState,
  option: MarkupOption,
  globals: MarkupGlobals = { variables: '', titles: '' },
): { transaction: Transaction; rejection?: never } | { transaction?: never; rejection: Rejection } {
  const text = state.doc.toString();
  const context = expandedContext(text, globals);
  if (!context) return { rejection: 'expansion' };
  const { tokens, tables } = protectedRanges(state, markupCommentContext(text).comments);
  const tableBlocks = [...context.text.matchAll(/< table [^]+?\n<\$>\n?/g)];
  const preparedTables = tableBlocks.map((block) => ({
    from: context.offsets[block.index],
    to: context.offsets[block.index + block[0].replace(/\n$/, '').length - 1] + 1,
    protectStart: true,
    protectEnd: true,
  }));
  for (const block of tableBlocks) {
    for (const match of block[0].matchAll(/\|[bchr\d-]*/g)) {
      const start = block.index + match.index;
      tokens.push({
        from: context.offsets[start],
        to: context.offsets[start + match[0].length - 1] + 1,
        protectStart: true,
      });
    }
  }
  if (
    option.kind === 'link' &&
    state.selection.ranges.some((range) =>
      preparedTables.some((table) => intersects(range.from, range.to, table)),
    )
  )
    return { rejection: 'table-link' };
  const unsafe = state.selection.ranges.some((range) => {
    const insertAtHead = option.kind === 'icon' || option.kind === 'line';
    const from = insertAtHead ? range.head : range.from;
    const to = insertAtHead ? range.head : range.to;
    const selected = state.sliceDoc(from, to);
    return (
      tokens.some((token) => intersects(from, to, token)) ||
      (!insertAtHead && selected.includes('/>')) ||
      ((option.kind === 'link' || option.kind === 'title') && selected.includes('[')) ||
      (option.kind === 'table' &&
        (selected.includes('|') ||
          [...tables, ...preparedTables].some((table) => intersects(from, to, table))))
    );
  });
  if (unsafe) return { rejection: 'context' };

  if (option.kind === 'line') {
    const pending = new Map<number, number>();
    for (const range of state.selection.ranges) {
      const position = context.offsets.findIndex((offset) => offset >= range.head);
      const point = position < 0 ? context.text.length : position;
      const start = point === 0 ? 0 : context.text.lastIndexOf('\n', point - 1) + 1;
      const end = context.text.indexOf('\n', point);
      const line = context.text.slice(start, end < 0 ? undefined : end);
      const inTable = tableBlocks.some(
        (block) => point >= block.index && point < block.index + block[0].length,
      );
      if (inTable && (line.startsWith('< table ') || line === '<$>'))
        return { rejection: 'context' };
      const allowed = inTable ? markupEmpty : markupLineClasses;
      const capacity = allowed.filter((name) => name === option.name).length;
      const marker = `<${option.name}/>`;
      const existing = line.split(marker).length - 1;
      const additions = (pending.get(start) ?? 0) + 1;
      if (existing + additions > capacity) return { rejection: 'line-style' };
      pending.set(start, additions);
    }
  }

  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    if (option.kind === 'icon' || option.kind === 'line') {
      const position = range.head;
      const insert = `<${option.name}/>`;
      return {
        changes: { from: position, insert },
        range: EditorSelection.range(
          range.anchor + (range.anchor >= position ? insert.length : 0),
          position + insert.length,
        ),
      };
    }

    if (option.kind === 'table') {
      const before = range.from > 0 && state.sliceDoc(range.from - 1, range.from) !== '\n';
      const after = range.to < state.doc.length && state.sliceDoc(range.to, range.to + 1) !== '\n';
      const prefix = `${before ? '\n' : ''}< table ${option.name} >\n| `;
      const content = (selected || 'Text').split('\n').join('\n| ');
      const insert = `${prefix}${content}\n<$>${after ? '\n' : ''}`;
      const start = range.from + prefix.length;
      const end = start + content.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range:
          range.anchor > range.head
            ? EditorSelection.range(end, start)
            : EditorSelection.range(start, end),
      };
    }

    const prefix = `<${option.name} `;
    const suffix =
      option.kind === 'link'
        ? ' [https://example.com] />'
        : option.kind === 'title'
          ? ' [Name] />'
          : ' />';
    const content = selected || 'Text';
    const insert = content
      .split('\n')
      .map((line) => `${prefix}${line}${suffix}`)
      .join('\n');
    const start = range.from + prefix.length;
    const end = range.from + insert.length - suffix.length;
    return {
      changes: { from: range.from, to: range.to, insert },
      range:
        range.anchor > range.head
          ? EditorSelection.range(end, start)
          : EditorSelection.range(start, end),
    };
  });
  return {
    transaction: state.update(changes, {
      annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
      scrollIntoView: true,
    }),
  };
}

export function markupTransaction(
  state: EditorState,
  option: MarkupOption,
  globals: MarkupGlobals = { variables: '', titles: '' },
): Transaction | null {
  return createMarkupTransaction(state, option, globals).transaction ?? null;
}

export function insertMarkup(
  view: EditorView,
  option: MarkupOption,
  globals: MarkupGlobals = { variables: '', titles: '' },
): 'inserted' | 'read-only' | 'composing' | Rejection {
  if (view.state.readOnly) return 'read-only';
  if (view.compositionStarted || view.composing) return 'composing';
  const result = createMarkupTransaction(view.state, option, globals);
  if (result.rejection) return result.rejection;
  view.dispatch(result.transaction);
  view.focus();
  return 'inserted';
}
