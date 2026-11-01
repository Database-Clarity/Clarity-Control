import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markupColors, markupIcons, markupLineClasses, markupTableClasses } from '@clarity/core';

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

export function markupTransaction(state: EditorState, option: MarkupOption) {
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

export function insertMarkup(view: EditorView, option: MarkupOption): boolean {
  if (view.state.readOnly || view.compositionStarted || view.composing) return false;
  view.dispatch(markupTransaction(view.state, option));
  view.focus();
  return true;
}
