import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, Transaction, type EditorState } from '@codemirror/state';
import {
  elementTagNames,
  findElementTags,
  lowerElementTags,
  type ElementTagName,
  type MarkupGlobals,
} from '@clarity/core';
import { insertionChecker } from './markupInsertion';

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

/** Why a selection cannot be tagged, phrased to follow "Can't tag: ". */
export const tagRefusals = {
  ranges: 'several selections',
  line: 'crosses a line',
  blank: 'only spaces',
  tag: 'crosses a tag',
  inside: 'already in a tag',
  cell: 'crosses a table cell',
  reference: 'holds a variable, formula, or comment',
  declaration: 'declaration line',
  expansion: 'an import or variable may change the markup',
} as const;

export type TagSelection =
  | { kind: 'none' }
  | { kind: 'wrap'; from: number; to: number }
  | { kind: 'refused'; reason: string };

const none: TagSelection = { kind: 'none' };
const refused = (reason: string): TagSelection => ({ kind: 'refused', reason });
const declaration = /^(?:title |export |var |import |enhanced \(|catalyst \(|exotic perk \(|\) *$)/;

/** The text that replaces `from`..`to` to tag it as `element`, absorbing an icon right before it. */
export function wrapChange(state: EditorState, from: number, to: number, element: string) {
  const icon = `<${element}/>`;
  const absorbed = from >= icon.length && state.sliceDoc(from - icon.length, from) === icon;
  return {
    from: absorbed ? from - icon.length : from,
    to,
    insert: `<${element} ${state.sliceDoc(from, to)} />`,
    absorbed,
  };
}

/** Whether the main selection can be tagged with an element, or why not (none: no selection). */
export function tagSelection(state: EditorState, globals: MarkupGlobals): TagSelection {
  const { ranges, main } = state.selection;
  if (ranges.every((range) => range.empty)) return none;
  if (ranges.length > 1) return refused(tagRefusals.ranges);
  const text = state.sliceDoc(main.from, main.to);
  if (text.includes('\n')) return refused(tagRefusals.line);
  if (!text.trim()) return refused(tagRefusals.blank);
  if (/[<[\]]/.test(text) || text.includes('/>')) return refused(tagRefusals.tag);
  if (text.includes('|')) return refused(tagRefusals.cell);
  if (/[#${}]|\/\*|\*\/|\/\//.test(text)) return refused(tagRefusals.reference);
  const line = state.doc.lineAt(main.from);
  if (declaration.test(line.text)) return refused(tagRefusals.declaration);
  // Text inside a tag (`<pve Slow />`, `<stasis Slow />`): tags never nest. An element tag's own
  // popover changes its element.
  for (const tag of line.text.matchAll(/<[a-z]+ [^<>]*?\/>/g))
    if (line.from + tag.index < main.from && main.to < line.from + tag.index + tag[0].length)
      return refused(tagRefusals.inside);
  const rejection = insertionChecker(state, globals)({ from: main.from, to: main.to });
  if (rejection === 'expansion') return refused(tagRefusals.expansion);
  if (rejection) return refused(tagRefusals.tag);
  // The result must be exactly one tagged span where the selection was, and lower to the old line
  // plus the icon (or to the old line itself when an icon was absorbed). Anything else, such as an
  // unclosed `<` earlier on the line that would swallow the new tag, is refused.
  const change = wrapChange(state, main.from, main.to, 'solar');
  const at = (position: number) => position - line.from;
  const next = line.text.slice(0, at(change.from)) + change.insert + line.text.slice(at(change.to));
  const placed = findElementTags(next).some(
    (tag) => tag.from === at(change.from) && tag.to === at(change.from) + change.insert.length,
  );
  const expected = change.absorbed
    ? line.text
    : line.text.slice(0, at(main.from)) + '<solar/>' + line.text.slice(at(main.from));
  if (!placed || lowerElementTags(next) !== lowerElementTags(expected))
    return refused(tagRefusals.tag);
  return { kind: 'wrap', from: main.from, to: main.to };
}

/** Tags the selection as `element`, or null when it cannot be tagged. The caret ends after the tag. */
export function wrapTransaction(
  state: EditorState,
  element: string,
  globals: MarkupGlobals,
): Transaction | null {
  if (!isElementName(element)) return null;
  const selection = tagSelection(state, globals);
  if (selection.kind !== 'wrap') return null;
  const change = wrapChange(state, selection.from, selection.to, element);
  return state.update({
    changes: { from: change.from, to: change.to, insert: change.insert },
    selection: EditorSelection.cursor(change.from + change.insert.length),
    annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
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
