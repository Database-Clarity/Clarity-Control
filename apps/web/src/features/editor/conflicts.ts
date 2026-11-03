import {
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import {
  findConflictBlocks,
  resolveConflictBlock,
  type ConflictBlock,
  type ConflictChoice,
} from '@clarity/core';

/**
 * Inline git-style conflicts. A save that found somebody else's changes leaves marker blocks in the
 * text (`<<<<<<< mine` … `=======` … `>>>>>>> theirs`); this extension colours them (mine green,
 * theirs blue, markers dim: backgrounds only, no padding or borders), puts the actions at the END
 * of the active block's first line, and walks the blocks with F8 / Shift+F8. The action widget is
 * absolutely positioned inside that line, so it never changes a line's height or moves any text.
 * Resolving is an ordinary edit (undoable), and so is deleting the markers by hand.
 */
export interface ConflictHost {
  /** A phone: the widget is one chip that opens the big-button panel instead of four small ones. */
  compact: boolean;
  onCompare(index: number): void;
  onPanel(index: number): void;
}

const noHost: ConflictHost = {
  compact: false,
  onCompare: () => undefined,
  onPanel: () => undefined,
};
export const conflictHost = Facet.define<ConflictHost, ConflictHost>({
  combine: (values) => values[values.length - 1] ?? noHost,
});

interface ConflictState {
  blocks: ConflictBlock[];
  /** The block the actions are offered on: the one holding the caret, else the last one visited. */
  active: number;
}

const setActive = StateEffect.define<number>();

function containing(blocks: readonly ConflictBlock[], head: number): number {
  return blocks.findIndex((block) => head >= block.from && head <= block.to);
}

const conflictState = StateField.define<ConflictState>({
  create: (state) => ({ blocks: findConflictBlocks(state.doc.toString()), active: 0 }),
  update(value, transaction) {
    let { blocks, active } = value;
    if (transaction.docChanged) blocks = findConflictBlocks(transaction.state.doc.toString());
    const forced = transaction.effects.find((effect) => effect.is(setActive));
    if (forced) active = forced.value;
    else if (transaction.docChanged || transaction.selection) {
      const inside = containing(blocks, transaction.state.selection.main.head);
      if (inside >= 0) active = inside;
    }
    active = Math.max(0, Math.min(active, blocks.length - 1));
    return blocks === value.blocks && active === value.active ? value : { blocks, active };
  },
});

/** The blocks of the document and which one is active, for the status bar and panels. */
export function conflictsOf(state: EditorState): ConflictState {
  return state.field(conflictState);
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly active: boolean,
    readonly canEdit: boolean,
    readonly compact: boolean,
  ) {
    super();
  }
  eq(other: ActionsWidget) {
    return (
      other.index === this.index &&
      other.active === this.active &&
      other.canEdit === this.canEdit &&
      other.compact === this.compact
    );
  }
  toDOM(view: EditorView) {
    // Read at click time: the host is reconfigured (phone / desktop) while the widget lives on.
    const host = {
      onCompare: (index: number) => view.state.facet(conflictHost).onCompare(index),
      onPanel: (index: number) => view.state.facet(conflictHost).onPanel(index),
    };
    const root = document.createElement('span');
    root.className = 'cm-conflict-actions';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', `Conflict ${this.index + 1}`);
    const add = (label: string, title: string, run: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      // The editor keeps focus and its caret: clicking an action is not leaving the text.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => run());
      root.append(button);
    };
    if (this.compact) {
      add('Resolve', 'Resolve this conflict', () => host.onPanel(this.index));
      return root;
    }
    if (this.active && this.canEdit) {
      add('Accept mine', 'Keep my lines', () => resolveBlock(view, this.index, 'mine'));
      add('Accept theirs', 'Keep their lines', () => resolveBlock(view, this.index, 'theirs'));
      add('Accept both', 'Keep mine, then theirs', () => resolveBlock(view, this.index, 'both'));
    }
    add('Compare', 'Mine, base and theirs side by side', () => host.onCompare(this.index));
    return root;
  }
  ignoreEvent() {
    return true;
  }
}

const line = (name: string) => Decoration.line({ class: `cm-conflict-line ${name}` });
const lines = {
  open: line('cm-conflict-marker cm-conflict-open'),
  openActive: line('cm-conflict-marker cm-conflict-open cm-conflict-current'),
  mine: line('cm-conflict-mine'),
  separator: line('cm-conflict-marker cm-conflict-separator'),
  theirs: line('cm-conflict-theirs'),
  close: line('cm-conflict-marker cm-conflict-close'),
};

function decorate(state: EditorState): DecorationSet {
  const { blocks, active } = state.field(conflictState);
  if (!blocks.length) return Decoration.none;
  const host = state.facet(conflictHost);
  const editable = !state.readOnly;
  const ranges: Range<Decoration>[] = [];
  blocks.forEach((block, index) => {
    const isActive = index === active;
    const first = state.doc.lineAt(block.from);
    const last = state.doc.lineAt(block.to);
    const separator = state.doc.lineAt(block.separatorFrom);
    for (let number = first.number; number <= last.number; number++) {
      const at = state.doc.line(number);
      const decoration =
        number === first.number
          ? isActive
            ? lines.openActive
            : lines.open
          : number === last.number
            ? lines.close
            : number === separator.number
              ? lines.separator
              : number < separator.number
                ? lines.mine
                : lines.theirs;
      ranges.push(decoration.range(at.from));
    }
    ranges.push(
      Decoration.widget({
        widget: new ActionsWidget(index, isActive, editable, host.compact),
        side: 1,
      }).range(block.openEnd),
    );
  });
  return Decoration.set(ranges, true);
}

/** Resolves one block with an ordinary, undoable edit; the actions move on to the next block. */
export function resolveBlock(view: EditorView, index: number, choice: ConflictChoice): boolean {
  const { blocks } = view.state.field(conflictState);
  const block = blocks[index];
  if (!block || view.state.readOnly) return false;
  const edit = resolveConflictBlock(view.state.doc.toString(), block, choice);
  view.dispatch({
    changes: edit,
    selection: { anchor: edit.from },
    effects: setActive.of(index),
    userEvent: 'input.conflict',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Moves to the next (or previous) block, wrapping round. False when there are none. */
export function jumpToConflict(view: EditorView, direction: 1 | -1): boolean {
  const { blocks } = view.state.field(conflictState);
  if (!blocks.length) return false;
  const head = view.state.selection.main.head;
  let target: number;
  if (direction === 1) {
    target = blocks.findIndex((block) => block.from > head);
    if (target < 0) target = 0;
  } else {
    target = -1;
    blocks.forEach((block, index) => {
      if (block.to < head) target = index;
    });
    if (target < 0) target = blocks.length - 1;
  }
  view.dispatch({
    selection: { anchor: blocks[target]!.from },
    effects: setActive.of(target),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function conflictExtensions(): Extension {
  return [
    conflictState,
    EditorView.decorations.compute([conflictState, conflictHost, EditorState.readOnly], decorate),
    keymap.of([
      { key: 'F8', run: (view) => jumpToConflict(view, 1) },
      { key: 'Shift-F8', run: (view) => jumpToConflict(view, -1) },
    ]),
  ];
}
