import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** The translation editor of `hash`, if it is on the page. */
export function translationView(hash: number): EditorView | null {
  const root = document.querySelector<HTMLElement>(`.cm-editor[data-tooltip-hash="${hash}"]`);
  return root ? EditorView.findFromDOM(root) : null;
}

/**
 * Puts `text` at the translation's caret (replacing a selection), as one undo step, and gives the
 * text focus back. A hidden editor (the phone's Editor tab, toggle mode's slot) lays out first.
 */
export function insertAtCaret(view: EditorView, text: string): boolean {
  if (view.state.readOnly) return false;
  view.dispatch({
    ...view.state.replaceSelection(text),
    annotations: Transaction.userEvent.of('input.paste'),
    scrollIntoView: true,
  });
  requestAnimationFrame(() => requestAnimationFrame(() => view.focus()));
  return true;
}
