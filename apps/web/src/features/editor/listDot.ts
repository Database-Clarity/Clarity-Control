import { Annotation, EditorSelection, Prec, StateField, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { markupCommentContext } from '@clarity/core';

const converted = Annotation.define<number>();
const pending = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    const position = tr.annotation(converted);
    if (position !== undefined) return position;
    return tr.docChanged || tr.selection ? null : value;
  },
});

export const listDot: Extension = [
  pending,
  EditorView.inputHandler.of((view, from, to, text) => {
    const { state } = view;
    if (
      text !== ' ' ||
      from !== to ||
      state.readOnly ||
      view.composing ||
      state.selection.ranges.length !== 1 ||
      !state.selection.main.empty
    )
      return false;
    const line = state.doc.lineAt(from);
    if (!/^[ \t]*-$/.test(state.sliceDoc(line.from, from))) return false;
    const prefix = state.sliceDoc(0, from);
    if (
      /<[^>]*$/.test(prefix) ||
      /\/\*[^]*$/.test(prefix.replace(/\/\*[^]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')) ||
      markupCommentContext(state.doc.toString()).comments.some(
        ({ from: start, to: end }) => start <= from && end >= from,
      )
    )
      return false;
    // Keep the typed space in history before the isolated automatic replacement.
    view.dispatch({
      changes: { from, insert: ' ' },
      selection: { anchor: from + 1 },
      userEvent: 'input.type',
    });
    view.dispatch({
      changes: { from: from - 1, to: from, insert: '•' },
      selection: EditorSelection.cursor(from + 1),
      annotations: [converted.of(from + 1), isolateHistory.of('full')],
      userEvent: 'input.listDot',
    });
    return true;
  }),
  Prec.highest(
    keymap.of([
      {
        key: 'Backspace',
        run(view) {
          const head = view.state.field(pending);
          if (head === null || view.state.readOnly || view.composing) return false;
          view.dispatch({
            changes: { from: head - 2, to: head - 1, insert: '-' },
            selection: { anchor: head },
            annotations: isolateHistory.of('full'),
            userEvent: 'input.listDot.cancel',
          });
          return true;
        },
      },
    ]),
  ),
];
