import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  markupColors,
  markupIcons,
  markupInlineRanges,
  markupLineClasses,
  markupTableClasses,
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
}

function protectedRanges(state: EditorState) {
  const text = state.doc.toString();
  const tokens: ProtectedRange[] = [];
  const tables: ProtectedRange[] = [];
  let tableStart: number | undefined;
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    for (const range of markupInlineRanges(line.text)) {
      tokens.push({ from: line.from + range.from, to: line.from + range.to });
    }
    for (const match of line.text.matchAll(/<[^>\n]*(?:>|$)/g)) {
      tokens.push({
        from: line.from + match.index,
        to: line.from + match.index + match[0].length,
        incomplete: !match[0].endsWith('>'),
        protectStart: match[0].startsWith('< table ') || match[0] === '<$>',
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
    for (const match of line.text.matchAll(/#[a-zA-Z0-9]+|\$\{[^}\n]*(?:}|$)/g)) {
      tokens.push({
        from: line.from + match.index,
        to: line.from + match.index + match[0].length,
        incomplete: match[0].startsWith('${') && !match[0].endsWith('}'),
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
      (from < protectedRange.to || (protectedRange.incomplete && from === protectedRange.to))
    );
  }
  return from < protectedRange.to && to > protectedRange.from;
}

export function markupTransaction(state: EditorState, option: MarkupOption): Transaction | null {
  const { tokens, tables } = protectedRanges(state);
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
        (selected.includes('|') || tables.some((table) => intersects(from, to, table))))
    );
  });
  if (unsafe) return null;

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
  return state.update(changes, {
    annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
}

export function insertMarkup(
  view: EditorView,
  option: MarkupOption,
): 'inserted' | 'read-only' | 'composing' | 'unsupported' {
  if (view.state.readOnly) return 'read-only';
  if (view.compositionStarted || view.composing) return 'composing';
  const transaction = markupTransaction(view.state, option);
  if (!transaction) return 'unsupported';
  view.dispatch(transaction);
  view.focus();
  return 'inserted';
}
