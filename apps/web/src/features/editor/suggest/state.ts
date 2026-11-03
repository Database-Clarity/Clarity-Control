import { isolateHistory } from '@codemirror/commands';
import {
  EditorSelection,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import type { MarkupGlobals } from '@clarity/core';
import { insertionMessages, insertionRejection, type Rejection } from '../markupInsertion';
import { recentSuggestions, rememberSuggestion } from './recent';
import {
  nextCategoryIndex,
  suggestContext,
  suggestItems,
  type SuggestContext,
  type SuggestItem,
} from './source';
import { setStops, stopsExtension } from './stops';

/** What the menu shows. Browsing only ever changes this, never the document. */
export interface SuggestSnapshot {
  context: SuggestContext;
  items: SuggestItem[];
  index: number;
  /** Opened by Ctrl+Space (so it also answers a bare word or a selection), not by typing. */
  explicit: boolean;
  /** Why the last Enter did not insert, until the next move. */
  message: string | null;
}

export interface SuggestHost {
  globals: MarkupGlobals;
  /** Called whenever the menu opens, moves or closes (the popover lives outside CodeMirror). */
  onChange?(snapshot: SuggestSnapshot | null): void;
}

export const suggestHost = Facet.define<SuggestHost, SuggestHost>({
  combine: (hosts) => hosts[hosts.length - 1] ?? { globals: { variables: '', titles: '' } },
});

const openEffect = StateEffect.define<{ explicit: boolean }>();
const closeEffect = StateEffect.define<null>();
const moveEffect = StateEffect.define<number>();
const categoryEffect = StateEffect.define<null>();
const messageEffect = StateEffect.define<string | null>();

const typedTriggers = new Set(['<', '#', '[']);

function derive(
  state: EditorState,
  explicit: boolean,
  previous: SuggestSnapshot | null,
): SuggestSnapshot | null {
  if (state.readOnly) return null;
  const context = suggestContext(state, explicit);
  if (!context) return null;
  const items = suggestItems(context, state, state.facet(suggestHost).globals, recentSuggestions());
  if (!items.length) return null;
  const kept = previous
    ? items.findIndex((item) => item.id === previous.items[previous.index]?.id)
    : -1;
  return { context, items, index: kept < 0 ? 0 : kept, explicit, message: null };
}

/** True when this transaction just typed one of the characters that opens the menu. */
function typedTrigger(transaction: Transaction): boolean {
  if (!transaction.docChanged || !transaction.isUserEvent('input.type')) return false;
  if (transaction.isUserEvent('input.type.compose')) return false;
  let typed = false;
  transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.length === 1 && typedTriggers.has(inserted.sliceString(0))) typed = true;
  });
  return typed;
}

export const suggestField = StateField.define<SuggestSnapshot | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    const explicitOpen = transaction.effects.find((effect) => effect.is(openEffect));
    if (transaction.effects.some((effect) => effect.is(closeEffect))) return null;
    if (explicitOpen) {
      next = derive(
        transaction.state,
        (explicitOpen.value as { explicit: boolean }).explicit,
        null,
      );
    } else if (next && (transaction.docChanged || transaction.selection)) {
      // A selection the author types over has nothing left to transform.
      next =
        next.context.kind === 'selection' && transaction.docChanged
          ? null
          : derive(transaction.state, next.explicit, next);
    } else if (!next && typedTrigger(transaction)) {
      next = derive(transaction.state, false, null);
    }
    if (!next) return null;
    for (const effect of transaction.effects) {
      if (effect.is(moveEffect)) {
        const count: number = next.items.length;
        next = { ...next, index: (((effect.value % count) + count) % count) | 0, message: null };
      } else if (effect.is(categoryEffect)) {
        next = { ...next, index: nextCategoryIndex(next.items, next.index), message: null };
      } else if (effect.is(messageEffect)) {
        next = { ...next, message: effect.value };
      }
    }
    return next;
  },
});

export const suggestState = (state: EditorState): SuggestSnapshot | null =>
  state.field(suggestField, false) ?? null;

export function openSuggest(view: EditorView): void {
  view.dispatch({ effects: openEffect.of({ explicit: true }) });
}
export function closeSuggest(view: EditorView): void {
  if (suggestState(view.state)) view.dispatch({ effects: closeEffect.of(null) });
}
/** Move by `delta` options (wraps), or to the absolute option when `absolute` is set. */
export function moveSuggest(view: EditorView, delta: number, absolute = false): void {
  const snapshot = suggestState(view.state);
  if (!snapshot) return;
  view.dispatch({ effects: moveEffect.of(absolute ? delta : snapshot.index + delta) });
}

export type AcceptResult = 'inserted' | 'none' | Rejection;

/** Inserts an option (the highlighted one by default). The only way the menu changes the text. */
export function acceptSuggestion(view: EditorView, index?: number): AcceptResult {
  const snapshot = suggestState(view.state);
  const item = snapshot?.items[index ?? snapshot.index];
  if (!snapshot || !item) return 'none';
  if (!item.reference) {
    const typed = snapshot.context.kind !== 'selection' || item.from === item.to;
    const rejection = insertionRejection(
      view.state,
      { from: item.from, to: item.to },
      view.state.facet(suggestHost).globals,
      { typed, link: item.link },
    );
    if (rejection) {
      view.dispatch({ effects: messageEffect.of(insertionMessages[rejection]) });
      return rejection;
    }
  }
  const stops = item.stops.map((stop) => ({
    from: item.from + stop.from,
    to: item.from + stop.to,
  }));
  const end = item.from + item.insert.length;
  const keepsSelection = snapshot.context.kind === 'selection' && item.from === item.to;
  const first = stops[0];
  view.dispatch({
    changes: { from: item.from, to: item.to, insert: item.insert },
    selection: keepsSelection
      ? EditorSelection.range(
          snapshot.context.from + item.insert.length,
          snapshot.context.to + item.insert.length,
        )
      : first
        ? EditorSelection.range(first.from, first.to)
        : EditorSelection.cursor(end),
    effects: [closeEffect.of(null), setStops.of(keepsSelection ? [] : stops)],
    annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
  rememberSuggestion(item.id);
  view.focus();
  return 'inserted';
}

const whenOpen =
  (run: (view: EditorView, snapshot: SuggestSnapshot) => boolean) => (view: EditorView) => {
    const snapshot = suggestState(view.state);
    return snapshot ? run(view, snapshot) : false;
  };

/** The part of the menu that follows the language and globals; goes in the reconfigurable block. */
export const suggestConfiguration = (host: SuggestHost): Extension => suggestHost.of(host);

/**
 * Enter and Tab insert the highlighted option. When it would only re-type what is already there
 * (the author finished the word, e.g. `#e`), the menu steps aside and the key keeps its usual job.
 */
function accept(view: EditorView, snapshot: SuggestSnapshot): boolean {
  const item = snapshot.items[snapshot.index];
  if (item && !item.stops.length && item.insert === view.state.sliceDoc(item.from, item.to)) {
    closeSuggest(view);
    return false;
  }
  acceptSuggestion(view);
  return true;
}

export function suggestExtension(): Extension {
  return [
    suggestField,
    stopsExtension(),
    Prec.highest(
      keymap.of([
        {
          key: 'Ctrl-Space',
          run: (view) => {
            const snapshot = suggestState(view.state);
            if (snapshot) view.dispatch({ effects: categoryEffect.of(null) });
            else openSuggest(view);
            return true;
          },
        },
        { key: 'ArrowDown', run: whenOpen((view) => (moveSuggest(view, 1), true)) },
        { key: 'ArrowUp', run: whenOpen((view) => (moveSuggest(view, -1), true)) },
        { key: 'PageDown', run: whenOpen((view) => (moveSuggest(view, 6), true)) },
        { key: 'PageUp', run: whenOpen((view) => (moveSuggest(view, -6), true)) },
        { key: 'Enter', run: whenOpen(accept) },
        { key: 'Tab', run: whenOpen(accept) },
        { key: 'Escape', run: whenOpen((view) => (closeSuggest(view), true)) },
      ]),
    ),
    EditorView.contentAttributes.compute([suggestField], (state) => {
      const snapshot = suggestState(state);
      const attributes: Record<string, string> = snapshot
        ? {
            'aria-haspopup': 'listbox',
            'aria-expanded': 'true',
            'aria-controls': 'editor-suggest-list',
            'aria-activedescendant': `editor-suggest-option-${snapshot.index}`,
          }
        : { 'aria-haspopup': 'listbox', 'aria-expanded': 'false' };
      return attributes;
    }),
    EditorView.domEventHandlers({
      blur: (_event, view) => {
        closeSuggest(view);
      },
    }),
    ViewPlugin.fromClass(
      class {
        update(update: { startState: EditorState; state: EditorState }) {
          const before = suggestState(update.startState);
          const after = suggestState(update.state);
          if (before !== after) update.state.facet(suggestHost).onChange?.(after);
        }
      },
    ),
  ];
}
