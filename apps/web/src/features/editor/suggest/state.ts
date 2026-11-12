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
import { checkedWrap, tagSelection } from '../elementTags';
import { askGroup, groupChange, pairAt } from '../iconPairs';
import { recentSuggestions, rememberSuggestion } from './recent';
import {
  caretContext,
  dropDeclinedPins,
  judgeItems,
  nextCategoryIndex,
  requestItems,
  suggestContext,
  suggestItems,
  type SuggestContext,
  type SuggestItem,
  unavailableReasons,
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
  /**
   * The options the insertion rules decline here are marked. An on-request menu shows first and
   * is judged right after (reading the document under those rules must not hold the menu up);
   * Enter is held to the rules either way.
   */
  judged: boolean;
  /** The author moved the selection; until then the menu may move it to an option that fits. */
  picked: boolean;
  /**
   * Where this menu sits in a longer task, shown muted above the detail (the translator's "Tag
   * the same words here": "2 of 4 in the translation"). Kept while browsing, gone with the menu.
   */
  aside?: string;
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
const judgeEffect = StateEffect.define<null>();
const asideEffect = StateEffect.define<string>();

const typedTriggers = new Set(['<', '#', '[']);

function derive(
  state: EditorState,
  explicit: boolean,
  previous: SuggestSnapshot | null,
): SuggestSnapshot | null {
  if (state.readOnly) return null;
  let context = suggestContext(state, explicit);
  if (!context) return null;
  // A menu opened on a bare word is about that word: once the caret is in another one it is done.
  const anchor = previous?.context.atCaret ? previous.context.from : -1;
  if (
    context.kind === 'word' &&
    anchor >= context.from &&
    anchor <= state.selection.main.head &&
    state.selection.main.empty
  )
    // Opened at the caret beside a word: what was typed since then filters, the word does not.
    context = caretContext(context, state, anchor);
  else if (
    previous?.context.kind === 'word' &&
    context.kind === 'word' &&
    context.from !== previous.context.from
  )
    return null;
  const globals = state.facet(suggestHost).globals;
  // On request the menu lists every option; the one that opens while typing only what fits.
  const list = explicit ? requestItems : suggestItems;
  let items = list(context, state, globals, recentSuggestions());
  if (!items.length && explicit && !previous && context.query) {
    // Asked for beside a word no option matches: the whole list, going in at the caret.
    context = caretContext(context, state);
    items = list(context, state, globals, recentSuggestions());
  }
  if (!items.length) return null;
  const kept = previous
    ? items.findIndex((item) => item.id === previous.items[previous.index]?.id)
    : -1;
  // Nothing pinned: start on the first option that can go here rather than on a greyed one.
  const first = items[0]?.pinned
    ? 0
    : Math.max(
        0,
        items.findIndex((item) => !item.unavailable),
      );
  return {
    context,
    items,
    index: kept < 0 ? first : kept,
    explicit,
    message: null,
    judged: !explicit,
    aside: previous?.aside,
    picked: kept < 0 ? false : (previous?.picked ?? false),
  };
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
        next = {
          ...next,
          index: (((effect.value % count) + count) % count) | 0,
          message: null,
          picked: true,
        };
      } else if (effect.is(categoryEffect)) {
        next = {
          ...next,
          index: nextCategoryIndex(next.items, next.index),
          message: null,
          picked: true,
        };
      } else if (effect.is(asideEffect)) {
        next = { ...next, aside: effect.value };
      } else if (effect.is(messageEffect)) {
        next = { ...next, message: effect.value };
      } else if (effect.is(judgeEffect) && !next.judged) {
        const globals = transaction.state.facet(suggestHost).globals;
        const judged = judgeItems(next.items, next.context, transaction.state, globals);
        const items = dropDeclinedPins(judged, next.context, transaction.state, globals);
        let index: number = next.index;
        if (items !== judged) {
          // The pinned part is gone and the list reordered: the selection stays on its option.
          const selected = judged[next.index]?.id;
          index = Math.max(
            0,
            items.findIndex((item) => item.id === selected),
          );
        }
        // A selection the author has not moved does not start on an option that cannot go here.
        // With none that fits, the first row.
        if (!next.picked && items[index]?.unavailable)
          index = Math.max(
            0,
            items.findIndex((item) => !item.unavailable),
          );
        next = { ...next, judged: true, items, index };
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
/** Moves the open menu to an option (absolute index) and says where it sits in a longer task. */
export function guideSuggest(view: EditorView, index: number, aside: string): void {
  if (!suggestState(view.state)) return;
  view.dispatch({ effects: [moveEffect.of(index), asideEffect.of(aside)] });
}
export function closeSuggest(view: EditorView): void {
  if (suggestState(view.state)) view.dispatch({ effects: closeEffect.of(null) });
}
/**
 * F1 over the open menu: closes it and returns the highlighted option's id, so the markup help can
 * open on that option (available or not). Null with no menu open.
 */
export function takeSuggestion(view: EditorView): string | null {
  const snapshot = suggestState(view.state);
  if (!snapshot) return null;
  const id = snapshot.items[snapshot.index]?.id ?? null;
  closeSuggest(view);
  return id;
}
/** Move by `delta` options (wraps), or to the absolute option when `absolute` is set. */
export function moveSuggest(view: EditorView, delta: number, absolute = false): void {
  const snapshot = suggestState(view.state);
  if (!snapshot) return;
  view.dispatch({ effects: moveEffect.of(absolute ? delta : snapshot.index + delta) });
}

/**
 * Marks the options that cannot go at this caret, if the open menu still waits for that. The
 * editor does this by itself once the menu has painted; nothing else needs to call it.
 */
export function judgeSuggestions(view: EditorView): void {
  const snapshot = suggestState(view.state);
  if (snapshot && !snapshot.judged) view.dispatch({ effects: judgeEffect.of(null) });
}

export type AcceptResult = 'inserted' | 'none' | 'unavailable' | Rejection;

/** What an insertion needs to know about the selection it happens beside. */
export interface InsertionTarget {
  /** The text was typed as a trigger (`<so`, a word): judged as the point it leaves behind. */
  typed: boolean;
  /** The selection the option sits in front of and leaves selected (its positions before the insert). */
  keepSelection?: { from: number; to: number };
}

/**
 * Applies an option to the document under the markup-safety rules, or says why it cannot. The one
 * place the suggestion menu, the markup row and the chips change the text.
 */
export function insertItem(
  view: EditorView,
  item: SuggestItem,
  target: InsertionTarget,
): Rejection | null {
  if (item.wrap) {
    // An element-tag wrap is judged again on the live text, by its own rules.
    const selection = tagSelection(view.state, view.state.facet(suggestHost).globals);
    const element = /^<([a-z]+) /.exec(item.insert)?.[1] ?? '';
    const change =
      selection.kind === 'wrap'
        ? checkedWrap(view.state, selection.from, selection.to, element)
        : null;
    if (!change || change.from !== item.from || change.insert !== item.insert) return 'context';
  } else if (item.group) {
    // "Group with icon" is judged again on the live text, by its own rules.
    const pair = pairAt(view.state);
    const change = pair && groupChange(view.state, pair, view.state.facet(suggestHost).globals);
    if (!pair || !change || change.from !== item.from || change.insert !== item.insert)
      return 'context';
    if (change.dropsSpace) {
      // It drops the space: the icon's popover asks first (symbols.ts), with the icon selected.
      view.dispatch({
        selection: { anchor: pair.iconFrom, head: pair.iconTo },
        effects: [closeEffect.of(null), askGroup.of(pair.iconFrom)],
        scrollIntoView: true,
      });
      rememberSuggestion(item.id);
      view.focus();
      return null;
    }
  } else if (!item.reference) {
    const rejection = insertionRejection(
      view.state,
      { from: item.from, to: item.to },
      view.state.facet(suggestHost).globals,
      { typed: target.typed, link: item.link, lineStyle: item.lineStyle },
    );
    if (rejection) return rejection;
  }
  const stops = item.stops.map((stop) => ({
    from: item.from + stop.from,
    to: item.from + stop.to,
  }));
  const end = item.from + item.insert.length;
  const keep = target.keepSelection;
  const first = stops[0];
  view.dispatch({
    changes: { from: item.from, to: item.to, insert: item.insert },
    selection: keep
      ? EditorSelection.range(keep.from + item.insert.length, keep.to + item.insert.length)
      : first
        ? EditorSelection.range(first.from, first.to)
        : EditorSelection.cursor(end),
    effects: [closeEffect.of(null), setStops.of(keep ? [] : stops)],
    annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
  rememberSuggestion(item.id);
  view.focus();
  return null;
}

/** Inserts an option (the highlighted one by default). */
export function acceptSuggestion(view: EditorView, index?: number): AcceptResult {
  const snapshot = suggestState(view.state);
  const item = snapshot?.items[index ?? snapshot.index];
  if (!snapshot || !item) return 'none';
  if (item.unavailable) {
    // Listed, but it has nowhere to go here: the text stays as it is and the menu says why.
    view.dispatch({ effects: messageEffect.of(item.unavailable) });
    return 'unavailable';
  }
  const keepsSelection = snapshot.context.kind === 'selection' && item.from === item.to;
  const rejection = insertItem(view, item, {
    typed: snapshot.context.kind !== 'selection' || item.from === item.to,
    keepSelection: keepsSelection
      ? { from: snapshot.context.from, to: snapshot.context.to }
      : undefined,
  });
  if (rejection) {
    // The on-request menu gives the same short reason its greyed options carry.
    view.dispatch({
      effects: messageEffect.of(
        snapshot.explicit ? unavailableReasons[rejection] : insertionMessages[rejection],
      ),
    });
    return rejection;
  }
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
  if (
    item &&
    !item.unavailable &&
    !item.stops.length &&
    item.insert === view.state.sliceDoc(item.from, item.to)
  ) {
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
            // Asked for over the menu that opened while typing, it becomes the full list; asked
            // for again, it steps to the next group.
            if (snapshot?.explicit) view.dispatch({ effects: categoryEffect.of(null) });
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
    EditorView.contentAttributes.of((view) => {
      const snapshot = suggestState(view.state);
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
        private frame = 0;
        private timer: ReturnType<typeof setTimeout> | undefined;
        private idle = 0;
        private waiting = false;
        private warm = 0;
        constructor(private readonly view: EditorView) {
          // Once per editor, when the browser is idle: the first request for the menu then finds
          // the full list's code and the document's facts ready, like every later one.
          if (typeof requestIdleCallback !== 'function') return;
          this.warm = requestIdleCallback(
            () => {
              const state = this.view.state;
              const context = state.readOnly ? null : suggestContext(state, true);
              if (!context) return;
              const globals = state.facet(suggestHost).globals;
              judgeItems(
                requestItems(context, state, globals, recentSuggestions()),
                context,
                state,
                globals,
              );
            },
            { timeout: 2000 },
          );
        }
        update(update: { startState: EditorState; state: EditorState }) {
          const before = suggestState(update.startState);
          const after = suggestState(update.state);
          if (before !== after) update.state.facet(suggestHost).onChange?.(after);
          if (!after || after.judged || this.waiting) return;
          // After the frame that shows the menu, once the browser has nothing else to do: opening
          // never waits for the safety rules, and neither does the first key after it.
          this.waiting = true;
          const judge = () => {
            this.waiting = false;
            judgeSuggestions(this.view);
          };
          if (typeof requestAnimationFrame === 'function')
            this.frame = requestAnimationFrame(() => {
              if (typeof requestIdleCallback === 'function')
                this.idle = requestIdleCallback(judge, { timeout: 150 });
              else this.timer = setTimeout(judge);
            });
          else this.timer = setTimeout(judge);
        }
        destroy() {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
          if (typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(this.idle);
            cancelIdleCallback(this.warm);
          }
          clearTimeout(this.timer);
        }
      },
    ),
  ];
}
