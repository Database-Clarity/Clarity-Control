// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { afterEach, expect, it } from 'vitest';
import { listDot } from './listDot';
const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));
function editor(doc = '-', readOnly = false) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [history(), listDot, EditorState.readOnly.of(readOnly)],
    }),
  });
  views.push(view);
  return view;
}
function space(view: EditorView) {
  const head = view.state.selection.main.head;
  let handled = false;
  view.state
    .facet(EditorView.inputHandler)
    .some(
      (handler) =>
        (handled = handler(view, head, head, ' ', () =>
          view.state.update({ changes: { from: head, insert: ' ' } }),
        )),
    );
  return handled;
}
function backspace(view: EditorView) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
  );
}
it('converts after indentation and restores the space with Backspace or undo', () => {
  for (const restore of [backspace, undo]) {
    const view = editor('  -');
    expect(space(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('  • ');
    restore(view);
    expect(view.state.doc.toString()).toBe('  - ');
  }
});
it.each(['word -', '--', '<bold\n-', '<title text [\n-', '/*\n-', '// -'])(
  'refuses protected or non-leading input: %s',
  (doc) => {
    expect(space(editor(doc))).toBe(false);
  },
);
it('refuses read-only and composition, and leaves programmatic/pasted changes alone', () => {
  expect(space(editor('-', true))).toBe(false);
  const view = editor();
  Object.defineProperty(view, 'composing', { value: true, configurable: true });
  expect(space(view)).toBe(false);
  Object.defineProperty(view, 'composing', { value: false });
  expect(space(view)).toBe(true);
  const pasted = editor('');
  pasted.dispatch({ changes: { from: 0, insert: '- ' }, userEvent: 'input.paste' });
  expect(pasted.state.doc.toString()).toBe('- ');
});
it('expires immediate restore after another edit or caret movement', () => {
  for (const edit of [false, true]) {
    const view = editor();
    space(view);
    view.dispatch(edit ? { changes: { from: 2, insert: 'x' } } : { selection: { anchor: 0 } });
    backspace(view);
    expect(view.state.doc.toString()).toContain('•');
  }
});
it('refuses a replacement range and multiple carets', () => {
  const view = editor('-');
  let handled = false;
  view.state.facet(EditorView.inputHandler).some(handler => handled = handler(view, 0, 1, ' ', () => view.state.update({})));
  expect(handled).toBe(false);
  const multiple = new EditorView({ state: EditorState.create({ doc: '-\n-', selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]), extensions: [listDot, EditorState.allowMultipleSelections.of(true)] }) });
  views.push(multiple);
  expect(space(multiple)).toBe(false);
});
it('leaves a dropped hyphen and space unchanged', () => {
  const view = editor('');
  view.dispatch({ changes: { from: 0, insert: '- ' }, userEvent: 'input.drop' });
  expect(view.state.doc.toString()).toBe('- ');
});
