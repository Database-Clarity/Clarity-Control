import { isolateHistory } from '@codemirror/commands';
import {
  EditorSelection,
  StateEffect,
  StateField,
  EditorState,
  Transaction,
} from '@codemirror/state';
import {
  elementTagNames,
  findElementTags,
  lowerElementTags,
  type MarkupGlobals,
} from '@clarity/core';
import { checkedWrap, elementLabel, isElementName, tagSelection } from './elementTags';
import { subclassNameAt } from './suggest/typedSymbols';

/**
 * "Group with icon" (concept B): an existing pair, one of the seven element icons right before a
 * word or a known element keyword (`<solar/>Firesprite`, `<arc/>Ionic Trace`), becomes one tagged
 * span (`<solar Firesprite />`). Its lowered form is the text as it was, so nothing a consumer reads
 * changes. A spaced pair (`<solar/> Firesprite`) groups only by dropping the space, which changes
 * the text; the author is asked first.
 */
export interface IconPair {
  element: string;
  /** The icon `<solar/>`. */
  iconFrom: number;
  iconTo: number;
  /** The word or keyword after it (after the one space of a spaced pair). */
  from: number;
  to: number;
  spaced: boolean;
  /** The words, as written. */
  text: string;
}

/**
 * "Group with icon" on a spaced pair asks first, in the icon's popover beside the button (symbols.ts):
 * grouping drops the space. Holds the icon's position while asking; any edit or selection change,
 * Escape, or Cancel ends it.
 */
export const askGroup = StateEffect.define<number | null>();
export const groupAsked = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(askGroup)) return effect.value;
    return value !== null && !transaction.docChanged && !transaction.selection ? value : null;
  },
});

const iconPattern = new RegExp(`<(${elementTagNames.join('|')})/>( ?)`, 'g');
const plainWord = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*/u;

/** The word or element keyword at the start of `after`, as long as `element` allows. */
export function pairWord(after: string, element: string): string | null {
  // A pair is an icon before a letter; the keyword (catalogue name) may run over several words.
  if (!/^\p{L}/u.test(after)) return null;
  const known = subclassNameAt(after);
  if (known && (known.icon === null || known.icon === element)) return known.word;
  return plainWord.exec(after)?.[0] ?? null;
}

/** Every pair on the line holding `pos` (positions are absolute). */
export function linePairs(state: EditorState, pos: number): IconPair[] {
  const line = state.doc.lineAt(pos);
  const pairs: IconPair[] = [];
  for (const match of line.text.matchAll(iconPattern)) {
    const iconFrom = line.from + match.index;
    const iconTo = iconFrom + match[0].length - match[2]!.length;
    const from = iconTo + match[2]!.length;
    const word = pairWord(line.text.slice(from - line.from), match[1]!);
    if (!word) continue;
    pairs.push({
      element: match[1]!,
      iconFrom,
      iconTo,
      from,
      to: from + word.length,
      spaced: match[2] === ' ',
      text: word,
    });
  }
  return pairs;
}

/**
 * The pair the selection is about: the selected icon, the selected words, or a caret on the icon or
 * in the words. Null otherwise.
 */
export function pairAt(state: EditorState): IconPair | null {
  const { from, to } = state.selection.main;
  if (state.selection.ranges.length > 1) return null;
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return null;
  return (
    linePairs(state, from).find((pair) =>
      from === to
        ? pair.iconFrom <= from && from <= pair.to
        : (from === pair.iconFrom && to === pair.iconTo) ||
          (from === pair.from && to === pair.to) ||
          (from === pair.iconFrom && to === pair.to),
    ) ?? null
  );
}

export interface GroupChange {
  from: number;
  to: number;
  insert: string;
  /** Grouping drops the space between the icon and the words (the text changes). */
  dropsSpace: boolean;
}

/**
 * The change that groups the pair, or null when the words cannot be tagged there (inside another
 * tag, a declaration line, a table cell, an import that may change the markup): the same rules as
 * tagging a selection. A joined pair must lower to the line exactly as it was.
 */
export function groupChange(
  state: EditorState,
  pair: IconPair,
  globals: MarkupGlobals,
): GroupChange | null {
  if (!isElementName(pair.element)) return null;
  // The words must be taggable as a selection would be. A bare state over the same document: the
  // rules read only the text, and the editor's own fields (this menu among them) must not rerun.
  const selected = EditorState.create({
    doc: state.doc,
    selection: EditorSelection.single(pair.from, pair.to),
  });
  if (tagSelection(selected, globals).kind !== 'wrap') return null;
  if (!pair.spaced) {
    const change = checkedWrap(selected, pair.from, pair.to, pair.element);
    if (!change?.absorbed) return null;
    return { from: change.from, to: change.to, insert: change.insert, dropsSpace: false };
  }
  const line = state.doc.lineAt(pair.from);
  const insert = `<${pair.element} ${pair.text} />`;
  const at = (position: number) => position - line.from;
  const next = line.text.slice(0, at(pair.iconFrom)) + insert + line.text.slice(at(pair.to));
  const placed = findElementTags(next).some(
    (tag) => tag.from === at(pair.iconFrom) && tag.to === at(pair.iconFrom) + insert.length,
  );
  // The only difference a consumer sees: the one space between the icon and the words.
  const expected = line.text.slice(0, at(pair.iconTo)) + line.text.slice(at(pair.from));
  if (!placed || lowerElementTags(next) !== lowerElementTags(expected)) return null;
  return { from: pair.iconFrom, to: pair.to, insert, dropsSpace: true };
}

/** One undo step; the caret ends after the new tag. */
export function groupTransaction(state: EditorState, change: GroupChange): Transaction {
  return state.update({
    changes: { from: change.from, to: change.to, insert: change.insert },
    selection: EditorSelection.cursor(change.from + change.insert.length),
    annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
}

/** "Group with icon" as a button title: what it writes. */
export function groupTitle(pair: IconPair): string {
  return `Tag “${pair.text}” as ${elementLabel(pair.element)}: <${pair.element} ${pair.text} />${pair.spaced ? ' (drops the space after the icon)' : ''}`;
}
