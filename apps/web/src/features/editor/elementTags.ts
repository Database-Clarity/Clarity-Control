import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, Transaction, type EditorState } from '@codemirror/state';
import {
  elementTagNames,
  findElementTags,
  lowerElementTags,
  type ElementTagName,
  type MarkupGlobals,
} from '@clarity/core';
import { tagSourceBlock } from './markupInsertion';
import { tagInsertionRefusal, type TagOracleRefusal } from './tagOracle';

/**
 * Authoring element-tagged text (concept B): `<solar Scorch />` is the Solar icon, then "Scorch" in
 * the Solar tint; its lowered form, what every consumer reads, is `<solar/>Scorch`. A wrappable
 * selection is one plain-text stretch on one non-declaration line, taken exactly as selected
 * (never trimmed). Wrapping it inserts nothing a consumer can see but the icon: the lowered text
 * equals the old text with `<solar/>` in front of the selection, or the old text itself when the
 * same icon already stood right before it (absorbed: `<solar/>Scorch` becomes `<solar Scorch />`).
 */
const elements: ReadonlySet<string> = new Set(elementTagNames);
export const isElementName = (name: string): name is ElementTagName => elements.has(name);
export const elementLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** A complete sentence naming what blocks tagging. */
export const tagRefusals = {
  ranges: 'Select one text range to tag.',
  line: 'The selection spans more than one line.',
  blank: 'The selection contains only whitespace.',
  tag: 'The selection overlaps a markup tag.',
  inside: 'The selection is already inside a tag.',
  cell: 'The selection touches a table cell marker.',
  formula: 'The selection overlaps a formula or value pair.',
  variable: 'The selection overlaps a variable.',
  comment: 'The selection overlaps a comment.',
  declaration: 'The selection is on a declaration line.',
} as const;

export type TagSelection =
  | { kind: 'none' }
  | { kind: 'wrap'; from: number; to: number }
  | { kind: 'refused'; reason: string };

const none: TagSelection = { kind: 'none' };
const refused = (reason: string): TagSelection => ({ kind: 'refused', reason });
const declaration = /^(?:title |export |var |import |enhanced \(|catalyst \(|exotic perk \(|\) *$)/;

/**
 * The wrap of `from`..`to` as `element`, checked on its own line: it must make exactly one tagged
 * span and lower to the same line with an icon before the text. Suggestions can supply the
 * catalogue spelling in place of the original text.
 */
export function checkedWrap(
  state: EditorState,
  from: number,
  to: number,
  element: string,
  text = state.sliceDoc(from, to),
) {
  const line = state.doc.lineAt(from);
  const icon = `<${element}/>`;
  const insert = `<${element} ${text} />`;
  const before = line.text.slice(0, from - line.from);
  const after = line.text.slice(to - line.from);
  for (const absorbed of [true, false]) {
    if (absorbed && !before.endsWith(icon)) continue;
    const prefix = absorbed ? before.slice(0, -icon.length) : before;
    const next = prefix + insert + after;
    const placed = findElementTags(next).some(
      (tag) => tag.from === prefix.length && tag.to === prefix.length + insert.length,
    );
    if (placed && lowerElementTags(next) === lowerElementTags(prefix + icon + text + after))
      return { from: line.from + prefix.length, to, insert, absorbed };
  }
  return null;
}

/** Whether the main selection can be tagged with an element, or why not (none: no selection). */
export function tagSelection(state: EditorState): TagSelection {
  const { ranges, main } = state.selection;
  if (ranges.every((range) => range.empty)) return none;
  if (ranges.length > 1) return refused(tagRefusals.ranges);
  const text = state.sliceDoc(main.from, main.to);
  // A selected icon is the icon's own popover (Group with icon, edit, remove), not a tag attempt.
  if (/^<[a-z]+\/>$/i.test(text)) return none;
  const reason = tagRangeRefusal(state, main.from, main.to);
  if (reason) return refused(reason);
  // Every element has the same shape, so Solar stands for them all here.
  if (!checkedWrap(state, main.from, main.to, 'solar')) return refused(tagRefusals.tag);
  return { kind: 'wrap', from: main.from, to: main.to };
}

/** Checks the plain-text source range shared by selection wraps and typed name completions. */
export function tagRangeRefusal(state: EditorState, from: number, to: number) {
  const text = state.sliceDoc(from, to);
  if (text.includes('\n')) return tagRefusals.line;
  if (!text.trim()) return tagRefusals.blank;
  const line = state.doc.lineAt(from);
  if (declaration.test(line.text)) return tagRefusals.declaration;
  if (/[<[\]]/.test(text) || text.includes('/>')) return tagRefusals.tag;
  if (text.includes('|')) return tagRefusals.cell;
  if (/\/\*|\*\/|\/\//.test(text)) return tagRefusals.comment;
  if (/\$|\{\{/.test(text)) return tagRefusals.formula;
  if (text.includes('#')) return tagRefusals.variable;
  if (/[{}]/.test(text)) return tagRefusals.formula;
  // Text inside a tag (`<pve Slow />`, `<stasis Slow />`): tags never nest. An element tag's own
  // popover changes its element.
  for (const tag of line.text.matchAll(/<[a-z]+ [^<>]*?\/>/g))
    if (line.from + tag.index < from && to < line.from + tag.index + tag[0].length)
      return tagRefusals.inside;
  const block = tagSourceBlock(state, from, to);
  return block ? tagRefusals[block] : null;
}

/** The same wrap rules apply when a suggestion also changes the text to its catalogue spelling. */
export function checkedNameTag(
  state: EditorState,
  from: number,
  to: number,
  element: ElementTagName,
  name: string,
) {
  if (state.selection.ranges.length !== 1 || tagRangeRefusal(state, from, to)) return null;
  return checkedWrap(state, from, to, element, name);
}

/** Tags the selection as `element`, or null when it cannot be tagged. The caret ends after the tag. */
export function tryWrapTransaction(
  state: EditorState,
  element: string,
  globals: MarkupGlobals,
):
  | { transaction: Transaction; rejection?: never }
  | { transaction?: never; rejection: TagOracleRefusal }
  | null {
  if (!isElementName(element)) return null;
  const selection = tagSelection(state);
  if (selection.kind !== 'wrap') return null;
  const change = checkedWrap(state, selection.from, selection.to, element);
  if (!change) return null;
  const rejection = tagInsertionRefusal(state.doc.toString(), change, globals);
  if (rejection) return { rejection };
  return {
    transaction: state.update({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: EditorSelection.cursor(change.from + change.insert.length),
      annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
      scrollIntoView: true,
    }),
  };
}

/** The tag selection of the editor that is showing, for the markup row's label and titles. */
export function createTagSelectionStore() {
  let current: TagSelection = none;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Only the mode is shown (and the reason): the same mode keeps the snapshot and notifies nobody. */
    set(next: TagSelection) {
      const same =
        next.kind === current.kind &&
        (next.kind !== 'refused' || current.kind !== 'refused' || next.reason === current.reason);
      if (same) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export type TagSelectionStore = ReturnType<typeof createTagSelectionStore>;
