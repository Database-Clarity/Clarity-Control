import {
  Facet,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { insertNewlineAndIndent } from '@codemirror/commands';
import {
  applicableTransforms,
  expandTemplate,
  extractBlocks,
  markupIcons,
  type MarkupGlobals,
} from '@clarity/core';
import { insertionRejection } from '../markupInsertion';
import { elementLabel, isElementName } from '../elementTags';
import { groupChange, linePairs } from '../iconPairs';
import type { SuggestItem } from '../suggest/source';
import { insertItem, suggestState } from '../suggest/state';
import {
  englishSymbols,
  longestSymbolName,
  subclassNameAt,
  subclassSymbol,
} from '../suggest/typedSymbols';
import type { EntryGlyph } from './entries';

/**
 * Suggestion chips: a one-line offer that floats beside the text when what you typed or selected
 * is something the markup can express better. It is only an offer: it takes no focus, moves no
 * text, and does nothing until the accept key is pressed while it is showing.
 *
 * - an icon name (replace it), a subclass name (prefix it), or `pve` / `pvp` (the tag);
 * - a selection one of the selection transforms understands (`6.5 [5]` becomes the PvE/PvP pair);
 * - an element icon just inserted right before a known keyword of that element (`<solar/>` before
 *   "Firesprite"): tag them together as `<solar Firesprite />`. Existing pairs never get one.
 */

export type ChipKey = 'enter' | 'tab';

export interface Chip {
  /** Identifies the offer, so a dismissed one stays dismissed until the text changes. */
  key: string;
  item: SuggestItem;
  /** The text was typed as a trigger (judged as the point it leaves behind). */
  typed: boolean;
  /** Where the selection goes back to after the offer is taken (the caret stays after a typed word). */
  keepSelection?: { from: number; to: number };
  /** Shown first in the chip: the icon, or the markup. */
  glyph?: EntryGlyph;
  /** The markup it writes. */
  markup: string;
  /** What it does, in a few words. */
  text: string;
  /** The first and last positions the chip must not cover (the selected text, or the typed word). */
  covers: { from: number; to: number };
}

export interface ChipHost {
  globals: MarkupGlobals;
  /** Which key takes the offer (the device setting). */
  acceptKey(): ChipKey;
  /** Called whenever the chip appears, changes or goes away (it is drawn outside CodeMirror). */
  onChange?(chip: Chip | null): void;
}

export const chipHost = Facet.define<ChipHost, ChipHost>({
  combine: (hosts) =>
    hosts[hosts.length - 1] ?? {
      globals: { variables: '', titles: '' },
      acceptKey: () => 'enter',
    },
});

interface ChipState {
  chip: Chip | null;
  /** The offer the author dismissed; the same one is not shown again. */
  dismissed: string | null;
}

const dismissEffect = StateEffect.define<null>();
const hideEffect = StateEffect.define<null>();

const typedTags = ['pve', 'pvp'] as const;
const iconByName = new Map(markupIcons.map((name) => [name.toLowerCase(), name]));
const longestWord = Math.max(
  ...markupIcons.map((name) => name.length),
  ...typedTags.map((tag) => tag.length),
);
/** A long selection is not a number or a short phrase; transforms never apply to it. */
const longestSelection = 2000;

function itemFor(
  partial: Omit<SuggestItem, 'category' | 'about' | 'preview' | 'keys' | 'stops'> & {
    category?: SuggestItem['category'];
    stops?: SuggestItem['stops'];
  },
): SuggestItem {
  return {
    category: 'Snippets',
    about: '',
    preview: null,
    keys: '',
    stops: [],
    ...partial,
  };
}

/** The offer for a word the author has just finished typing, if it names a tag. */
function wordChip(state: EditorState, globals: MarkupGlobals): Chip | null {
  const main = state.selection.main;
  if (!main.empty) return null;
  const line = state.doc.lineAt(main.head);
  // Only a known icon/tag can become a chip. Inspect its maximum length plus
  // one boundary character instead of matching every word on the edited line.
  const english = englishSymbols(state);
  const limit = english ? Math.max(longestWord, longestSymbolName()) : longestWord;
  const before = state.doc.sliceString(Math.max(line.from, main.head - limit - 1), main.head);
  let start = before.length;
  while (start > 0) {
    const code = before.charCodeAt(start - 1);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) break;
    start--;
  }
  if (start === before.length || before.length - start > limit) return null;
  if (start > 0) {
    if (/[\p{L}\p{N}_]/u.test(before[start - 1]!) || '<#$/{|'.includes(before[start - 1]!))
      return null;
  }
  // Only at the end of the word: more letters after the caret means the author is mid-word.
  const next = state.doc.sliceString(main.head, Math.min(line.to, main.head + 1));
  if (/[\p{L}\p{N}_]/u.test(next)) return null;
  const lastWord = before.slice(start);
  const subclass = english ? subclassSymbol(before, lastWord) : null;
  const word = subclass?.word ?? lastWord;
  const from = main.head - word.length;
  const icon = subclass?.icon ?? iconByName.get(word.toLowerCase());
  if (icon && word.length >= 3) {
    const keep = Boolean(subclass) || !english;
    const to = keep ? from : main.head;
    const rejection = insertionRejection(state, { from, to }, globals, { typed: !keep });
    if (rejection) return null;
    return {
      key: `icon:${icon}:${from}`,
      item: itemFor({
        id: `icon:${icon}`,
        label: `<${icon}/>`,
        from,
        to,
        insert: `<${icon}/>`,
      }),
      typed: !keep,
      keepSelection: keep ? { from: main.head, to: main.head } : undefined,
      glyph: { kind: 'icon', name: icon },
      markup: `<${icon}/>`,
      text: keep ? `${icon} symbol before “${word}”` : `${icon} symbol`,
      covers: { from, to: main.head },
    };
  }
  // Tags are lower-case words; "PvE" written in a sentence is just text.
  const tag = typedTags.find((name) => name === word);
  if (tag) {
    const rejection = insertionRejection(state, { from, to: main.head }, globals, { typed: true });
    if (rejection) return null;
    const template = tag === 'pve' ? '<pve {{1:value}} />' : '<pvp [{{1:value}}] />';
    const expanded = expandTemplate(template);
    return {
      key: `tag:${tag}:${from}`,
      item: itemFor({
        id: `tag:${tag}`,
        label: `<${tag} />`,
        from,
        to: main.head,
        insert: expanded.text,
        stops: expanded.stops,
      }),
      typed: true,
      markup: expanded.text,
      text: tag === 'pve' ? 'PvE value' : 'PvP value',
      covers: { from, to: main.head },
    };
  }
  return null;
}

/** The offer for a selection a transform understands. */
function selectionChip(
  state: EditorState,
  globals: MarkupGlobals,
  titles: readonly string[],
): Chip | null {
  const main = state.selection.main;
  if (main.empty || main.to - main.from > longestSelection) return null;
  const selected = state.sliceDoc(main.from, main.to);
  const [first] = applicableTransforms(selected, { titles });
  if (!first) return null;
  const rejection = insertionRejection(state, { from: main.from, to: main.to }, globals, {
    typed: false,
  });
  if (rejection) return null;
  return {
    key: `transform:${first.transform.id}:${main.from}-${main.to}`,
    item: itemFor({
      id: `transform:${first.transform.id}`,
      category: 'Transforms',
      label: first.transform.label,
      from: main.from,
      to: main.to,
      insert: first.output,
    }),
    typed: false,
    markup: first.output,
    text: first.transform.label,
    covers: { from: main.from, to: main.to },
  };
}

/** The element icon one change just inserted (the row, All, Ctrl+Space, a chip), if any. */
function insertedIcon(transaction: Transaction): { element: string; to: number } | null {
  if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return null;
  let found: { element: string; to: number } | null = null;
  let changes = 0;
  transaction.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
    changes++;
    const icon = /^<([a-z]+)\/>$/.exec(inserted.sliceString(0, 20));
    if (icon && isElementName(icon[1]!)) found = { element: icon[1]!, to: toB };
  });
  return changes === 1 ? found : null;
}

/**
 * Right after an element icon goes in before a known keyword of the same element, with the caret
 * still beside it: the offer to tag them together. Only the catalogue's names count, so an icon
 * before any other word gets no offer.
 */
function keywordChip(state: EditorState, icon: { element: string; to: number }): Chip | null {
  const main = state.selection.main;
  if (!main.empty || main.head !== icon.to || state.readOnly || suggestState(state)) return null;
  const line = state.doc.lineAt(icon.to);
  const known = subclassNameAt(state.sliceDoc(icon.to, Math.min(line.to, icon.to + 60)));
  if (known?.icon !== icon.element) return null;
  const pair = linePairs(state, icon.to).find((candidate) => candidate.iconTo === icon.to);
  if (!pair || pair.spaced || pair.to !== icon.to + known.word.length) return null;
  const change = groupChange(state, pair, state.facet(chipHost).globals);
  if (!change || change.dropsSpace) return null;
  return {
    key: `group:${pair.iconFrom}:${pair.text}`,
    item: itemFor({
      id: 'transform:group-with-icon',
      category: 'Transforms',
      label: 'Group with icon',
      from: change.from,
      to: change.to,
      insert: change.insert,
      group: 'joined',
    }),
    typed: false,
    glyph: { kind: 'icon', name: pair.element },
    markup: change.insert,
    text: `Tag as ${elementLabel(pair.element)}`,
    covers: { from: pair.iconFrom, to: pair.to },
  };
}

function evaluate(state: EditorState, typedKey: boolean): Chip | null {
  if (state.readOnly) return null;
  if (suggestState(state)) return null;
  const host = state.facet(chipHost);
  const main = state.selection.main;
  if (main.empty) return typedKey ? wordChip(state, host.globals) : null;
  const titles = Object.keys({
    ...extractBlocks(state.doc.toString(), 'title'),
    ...extractBlocks(host.globals.titles, 'title'),
  });
  return selectionChip(state, host.globals, titles);
}

export const chipField = StateField.define<ChipState>({
  create: () => ({ chip: null, dismissed: null }),
  update(value, transaction) {
    if (transaction.effects.some((effect) => effect.is(dismissEffect)))
      return { chip: null, dismissed: value.chip?.key ?? value.dismissed };
    if (transaction.effects.some((effect) => effect.is(hideEffect)))
      return { chip: null, dismissed: value.dismissed };
    if (!transaction.docChanged && !transaction.selection) return value;
    const typedKey =
      transaction.docChanged &&
      transaction.isUserEvent('input.type') &&
      !transaction.isUserEvent('input.type.compose');
    // An element icon just inserted before its keyword: the offer to tag them together.
    const icon = transaction.docChanged && !typedKey ? insertedIcon(transaction) : null;
    if (icon) {
      const chip = keywordChip(transaction.state, icon);
      return { chip, dismissed: null };
    }
    // Anything else that changes the text (paste, delete, undo, an accepted offer) clears it.
    if (transaction.docChanged && !typedKey) return { chip: null, dismissed: null };
    const chip = evaluate(transaction.state, typedKey);
    if (!chip) return { chip: null, dismissed: null };
    return chip.key === value.dismissed
      ? { chip: null, dismissed: value.dismissed }
      : { chip, dismissed: null };
  },
});

/**
 * Whether the chip is actually on screen (it hides itself when its text scrolls away or there is no
 * room for it). Enter and Tab only take an offer the author can see.
 */
const shown = new WeakMap<EditorView, boolean>();
export function markChipShown(view: EditorView, visible: boolean): void {
  shown.set(view, visible);
}
const chipVisible = (view: EditorView) =>
  Boolean(chipState(view.state)) && shown.get(view) === true;

export const chipState = (state: EditorState): Chip | null =>
  state.field(chipField, false)?.chip ?? null;

export function dismissChip(view: EditorView): boolean {
  if (!chipVisible(view)) return false;
  view.dispatch({ effects: dismissEffect.of(null) });
  return true;
}

/** Takes the offer. False when there was none or the document refused it. */
export function acceptChip(view: EditorView): boolean {
  const chip = chipState(view.state);
  if (!chip || !chipVisible(view)) return false;
  const rejection = insertItem(view, chip.item, {
    typed: chip.typed,
    keepSelection: chip.keepSelection,
  });
  if (rejection) {
    dismissChip(view);
    return false;
  }
  return true;
}

export function chipsExtension(): Extension {
  return [
    // After the suggestion menu: an open menu always wins over a chip.
    chipField,
    Prec.highest(
      keymap.of([
        {
          key: 'Enter',
          run: (view) =>
            chipState(view.state) && view.state.facet(chipHost).acceptKey() === 'enter'
              ? acceptChip(view)
              : false,
        },
        {
          key: 'Tab',
          run: (view) =>
            chipState(view.state) && view.state.facet(chipHost).acceptKey() === 'tab'
              ? acceptChip(view)
              : false,
        },
        // The line break stays available while an offer shows.
        {
          key: 'Shift-Enter',
          run: (view) => (chipVisible(view) ? insertNewlineAndIndent(view) : false),
        },
        { key: 'Escape', run: (view) => dismissChip(view) },
      ]),
    ),
    EditorView.domEventHandlers({
      blur: (_event, view) => {
        if (chipState(view.state)) view.dispatch({ effects: hideEffect.of(null) });
      },
    }),
    ViewPlugin.fromClass(
      class {
        update(update: { startState: EditorState; state: EditorState }) {
          const before = chipState(update.startState);
          const after = chipState(update.state);
          if (before !== after) update.state.facet(chipHost).onChange?.(after);
        }
      },
    ),
  ];
}
