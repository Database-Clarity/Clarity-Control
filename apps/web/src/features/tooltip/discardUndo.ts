import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Drafts } from '../../services/draftStorage';

type Entry = Drafts[string];
/** One tooltip's whole draft changes from `from` to `to` (undefined: no draft). */
export interface DraftSwap {
  hash: number;
  from: Entry | undefined;
  to: Entry | undefined;
}

const swap = StateEffect.define<DraftSwap>();
const handlers = new WeakMap<EditorView, (change: DraftSwap) => void>();
/** Marks a view that already has the extension (a full reconfigure would drop it). */
const installed = StateField.define<true>({ create: () => true, update: (value) => value });
const extension = [
  installed,
  invertedEffects.of((tr) =>
    tr.effects
      .filter((effect) => effect.is(swap))
      .map(({ value }) => swap.of({ hash: value.hash, from: value.to, to: value.from })),
  ),
  // Ahead of the editor's own change listener, so its edit lands on the restored draft.
  Prec.highest(
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions)
        if (tr.isUserEvent('undo') || tr.isUserEvent('redo'))
          for (const effect of tr.effects)
            if (effect.is(swap)) handlers.get(update.view)?.(effect.value);
    }),
  ),
];

/**
 * Discard as one editor step: the saved text goes back into the editor, and the step carries the
 * whole draft, so undo hands `apply` the draft to restore (every language and field) and redo
 * hands it the discard again. The caller then discards the draft as usual.
 */
export function discardInEditor(
  view: EditorView,
  hash: number,
  draft: Entry,
  saved: string,
  apply: (change: DraftSwap) => void,
) {
  handlers.set(view, apply);
  if (view.state.field(installed, false) === undefined)
    view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
  view.dispatch({
    changes:
      view.state.doc.toString() === saved
        ? undefined
        : { from: 0, to: view.state.doc.length, insert: saved },
    selection: { anchor: 0 },
    effects: swap.of({ hash, from: draft, to: undefined }),
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('delete')],
    scrollIntoView: true,
  });
}
