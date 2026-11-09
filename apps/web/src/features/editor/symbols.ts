import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  showTooltip,
  tooltips,
  type DecorationSet,
  type Tooltip,
} from '@codemirror/view';
import { markupIcons, markupRetiredColors } from '@clarity/core';
import previewStyles from '../preview/TooltipPreview.module.scss';
import type { SymbolReveal } from '../../stores/settings';

/**
 * Symbol view. An icon tag (`<arc/>`) is drawn as one fixed-width symbol widget. A colour tag
 * (`<yellow … />`, `<pve … />`, `<bold … />`) is hidden and the text it encloses is drawn in the tag's
 * colour, like a syntax highlighter. The document is never changed by drawing: only what is shown is
 * replaced, and search, spellcheck and copy all work on the raw text.
 */
export const symbolColours = ['yellow', 'pve', 'pvp', 'bold'] as const;
const icons: ReadonlySet<string> = new Set(markupIcons);
const retiredColours: ReadonlySet<string> = new Set(markupRetiredColors);
/**
 * The colours drawn as tints: the current ones plus the retired ones, which the parser and the
 * preview still render, so existing text looks as it always did until it is fixed (P0a).
 */
const colours: ReadonlySet<string> = new Set([...symbolColours, ...markupRetiredColors]);

export interface SymbolRange {
  from: number;
  to: number;
  kind: 'icon';
  /** The icon name (the same names the markup row uses). */
  name: string;
}

/** A paired colour tag: `from…openTo` is the opening markup, `closeFrom…to` the closing one. */
export interface TagRange {
  from: number;
  openTo: number;
  closeFrom: number;
  to: number;
  /** The colour name (`yellow`, `pve`, `bold`, …). */
  name: string;
}

/**
 * The converter's own tokenizer (`<.+?\/>`, per line): a token runs from a `<` to the FIRST `/>`
 * after it, so colour tags do not nest. `<yellow a <blue b />` is one yellow token whose text is
 * `a <blue b`, and the ` c />` after it is plain text. The preview renders exactly this, so the
 * editor tints exactly this (UI-FIXES-2B 7). Icons are separate: they stay symbols wherever they
 * sit (PRODUCT.md "icons stay symbols"), so they are found on their own, not through these tokens.
 */
const converterToken = /<.+?\/>/g;

function* lineTokens(text: string, offset: number) {
  let lineFrom = offset;
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(converterToken))
      yield { text: match[0], from: lineFrom + (match.index ?? 0) };
    lineFrom += line.length + 1;
  }
}

/** Finds every icon tag in a text, including one written inside another tag. */
export function findSymbols(text: string, offset = 0): SymbolRange[] {
  const found: SymbolRange[] = [];
  for (const match of text.matchAll(/<(\w+)\/>/g)) {
    if (!icons.has(match[1])) continue;
    const from = offset + (match.index ?? 0);
    found.push({ from, to: from + match[0].length, kind: 'icon', name: match[1] });
  }
  return found;
}

/**
 * Finds every paired colour tag, sorted by position. A tag is one converter token, `<name … />`:
 * it closes at the first `/>` and does not nest. Tags pair per line, so an opening without its
 * ` />` (or a stray ` />`) is left raw, and so is a tag that encloses nothing.
 */
export function findTags(text: string, offset = 0): TagRange[] {
  const found: TagRange[] = [];
  for (const token of lineTokens(text, offset)) {
    const open = /^<(\w+) /.exec(token.text);
    if (!open || !colours.has(open[1]) || !token.text.endsWith(' />')) continue;
    const openTo = token.from + open[0].length;
    const to = token.from + token.text.length;
    const closeFrom = to - ' />'.length;
    if (closeFrom > openTo) found.push({ from: token.from, openTo, closeFrom, to, name: open[1] });
  }
  return found;
}

class SymbolWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }
  eq(other: SymbolWidget) {
    return other.name === this.name;
  }
  toDOM() {
    const element = document.createElement('span');
    element.className = 'cm-symbol cm-symbol-icon';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.symbol = this.name;
    // The icon classes are the preview's own, so the light theme's outlined copies come along.
    element.classList.add(previewStyles[this.name] ?? '');
    return element;
  }
  ignoreEvent() {
    return false;
  }
}

export const toggleRaw = StateEffect.define<boolean>();
/** Document-wide raw view: the widgets and tints go away and the markup shows as it is stored. */
export const rawMode = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(toggleRaw)) return effect.value;
    return value;
  },
});

const setReveal = StateEffect.define<SymbolReveal>();
const reveal = StateField.define<SymbolReveal>({
  create: () => 'popover',
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setReveal)) return effect.value;
    return value;
  },
});

interface Target {
  from: number;
  to: number;
  /** Set for a colour tag: the document position the popover is anchored to. */
  at?: number;
}
interface Popover extends Target {
  /** Where it came from: the pointer (hover) or a selected symbol/tag (pinned, can be edited). */
  source: 'hover' | 'selected';
  editing: boolean;
}
const setHover = StateEffect.define<Target | null>();
const setEditing = StateEffect.define<boolean>();
/** Pins the popover of the colour tag whose enclosed text is the selection (Alt+click or Alt+Enter only). */
export const pinTag = StateEffect.define<boolean>();

const hovered = StateField.define<Target | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setHover)) return effect.value;
    if (value && transaction.docChanged) return null;
    return value;
  },
});
const editing = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setEditing)) return effect.value;
    return value && !transaction.docChanged && !transaction.selection ? value : false;
  },
});

/**
 * A colour tag is pinned only by an explicit Alt+click or Alt+Enter: a double-click, or a keyboard selection that
 * happens to be exactly a tag's text (one tinted word), is just a selection, so Backspace deletes
 * that word instead of silently removing the tag. Any later selection change or edit unpins it.
 */
const tagPinned = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(pinTag)) return effect.value;
    return value && !transaction.docChanged && !transaction.selection ? value : false;
  },
});

/** The icon that is exactly the selection (chosen with a click or the arrows). */
function selectedSymbol(state: EditorState): SymbolRange | null {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  return (
    findSymbols(state.doc.sliceString(from, to), from).find(
      (s) => s.from === from && s.to === to,
    ) ?? null
  );
}

/** The pinned colour tag: its whole range, or its enclosed text, is exactly the selection. */
function selectedTag(state: EditorState): TagRange | null {
  const { from, to } = state.selection.main;
  if (from === to || !state.field(tagPinned)) return null;
  const line = state.doc.lineAt(from);
  if (to > line.to) return null;
  const matching = findTags(line.text, line.from).filter(
    (t) => (t.from === from && t.to === to) || (t.openTo === from && t.closeFrom === to),
  );
  return matching.pop() ?? null;
}

/** The innermost colour tag whose enclosed text contains the position. */
function tagAt(state: EditorState, pos: number): TagRange | null {
  const line = state.doc.lineAt(pos);
  const around = findTags(line.text, line.from).filter(
    (t) => t.openTo <= pos && pos <= t.closeFrom,
  );
  return around.pop() ?? null;
}

function symbolRanges(state: EditorState, from = 0, to = state.doc.length): Range<Decoration>[] {
  const text = state.doc.sliceString(from, to);
  const caret = state.field(reveal) === 'caret';
  const touched = (from: number, to: number) =>
    caret && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const ranges = findSymbols(text, from)
    .filter((symbol) => !touched(symbol.from, symbol.to))
    .map((symbol) =>
      Decoration.replace({ widget: new SymbolWidget(symbol.name) }).range(symbol.from, symbol.to),
    );
  for (const tag of findTags(text, from)) {
    ranges.push(
      Decoration.mark({ class: `cm-tint cm-tint-${tag.name}` }).range(tag.openTo, tag.closeFrom),
    );
    // The markup is hidden (zero width, atomic) unless the caret is in the tag.
    if (!touched(tag.from, tag.to)) {
      ranges.push(Decoration.replace({}).range(tag.from, tag.openTo));
      ranges.push(Decoration.replace({}).range(tag.closeFrom, tag.to));
    }
  }
  return ranges;
}

function build(state: EditorState): DecorationSet {
  return state.field(rawMode) ? Decoration.none : Decoration.set(symbolRanges(state), true);
}

/** Icons and colour tags are line-local. Rebuild only the lines an edit can change. */
function changedLines(transaction: Transaction) {
  const lines: { from: number; to: number }[] = [];
  const add = (from: number, to: number) =>
    lines.push({
      from: transaction.state.doc.lineAt(from).from,
      to: transaction.state.doc.lineAt(to).to,
    });
  transaction.changes.iterChangedRanges((_from, _to, from, to) => add(from, to));
  if (transaction.state.field(reveal) === 'caret' && transaction.selection) {
    // Moving a caret can reveal its new tag and hide its previous one, including
    // edits that move a selection somewhere outside the edited lines.
    for (const range of transaction.startState.selection.ranges)
      add(transaction.changes.mapPos(range.from, -1), transaction.changes.mapPos(range.to, 1));
    for (const range of transaction.state.selection.ranges) add(range.from, range.to);
  }
  lines.sort((a, b) => a.from - b.from);
  const merged: typeof lines = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    if (previous && line.from <= previous.to) previous.to = Math.max(previous.to, line.to);
    else merged.push(line);
  }
  return merged;
}

const symbolDecorations = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    const modeChanged =
      transaction.startState.field(rawMode) !== transaction.state.field(rawMode) ||
      transaction.startState.field(reveal) !== transaction.state.field(reveal);
    if (modeChanged) return build(transaction.state);
    if (
      !transaction.docChanged &&
      !(transaction.state.field(reveal) === 'caret' && transaction.selection)
    )
      return value;
    if (transaction.state.field(rawMode)) return Decoration.none;
    const lines = changedLines(transaction);
    return value.map(transaction.changes).update({
      filterFrom: lines[0].from,
      filterTo: lines.at(-1)!.to,
      filter: (from, to) => !lines.some((line) => from <= line.to && to >= line.from),
      add: lines.flatMap((line) => symbolRanges(transaction.state, line.from, line.to)),
      sort: true,
    });
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    // The icons and the hidden markup are atomic; the tinted text itself is ordinary text.
    EditorView.atomicRanges.of((view) =>
      view.state.field(field).update({ filter: (_from, _to, value) => !value.spec.class }),
    ),
  ],
});

function popoverFor(state: EditorState): Popover | null {
  if (state.field(rawMode) || state.field(reveal) !== 'popover') return null;
  const symbol = selectedSymbol(state);
  if (symbol) {
    return { from: symbol.from, to: symbol.to, source: 'selected', editing: state.field(editing) };
  }
  const tag = selectedTag(state);
  if (tag) {
    return {
      from: tag.from,
      to: tag.to,
      at: tag.openTo,
      source: 'selected',
      editing: state.field(editing),
    };
  }
  const hover = state.field(hovered);
  if (hover) return { ...hover, source: 'hover', editing: false };
  return null;
}

function popoverDom(view: EditorView, popover: Popover) {
  const dom = document.createElement('div');
  dom.className = 'cm-symbol-popover';
  const tag =
    popover.at === undefined
      ? null
      : (findTags(
          view.state.doc.lineAt(popover.from).text,
          view.state.doc.lineAt(popover.from).from,
        ).find((t) => t.from === popover.from && t.to === popover.to) ?? null);
  // An icon is edited whole; a colour tag shows as `<yellow … />` and its opening markup is edited.
  const edited = tag ? { from: tag.from, to: tag.openTo } : { from: popover.from, to: popover.to };
  const markup = view.state.sliceDoc(edited.from, edited.to);
  if (popover.editing) {
    const input = document.createElement('input');
    input.className = 'cm-symbol-input';
    input.value = tag ? markup.trimEnd() : markup;
    input.spellcheck = false;
    input.setAttribute('aria-label', tag ? 'Colour tag markup' : 'Symbol markup');
    const finish = (commit: boolean) => {
      // Emptying a colour tag's markup removes the tag and keeps its text, never a stray " />".
      if (commit && tag && input.value.trim() === '') {
        removeTag(view, tag, [setEditing.of(false)]);
        view.focus();
        return;
      }
      const next = tag ? `${input.value.trimEnd()} ` : input.value;
      view.dispatch({
        // The edited tag stays pinned: its enclosed text is still the selection.
        effects: commit && tag ? [setEditing.of(false), pinTag.of(true)] : setEditing.of(false),
        ...(commit && next !== markup
          ? {
              changes: { from: edited.from, to: edited.to, insert: next },
              selection: tag
                ? {
                    anchor: edited.from + next.length,
                    head: tag.closeFrom + next.length - markup.length,
                  }
                : { anchor: edited.from + next.length },
            }
          : {}),
      });
      view.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      event.stopPropagation();
    });
    dom.append(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  } else {
    const code = document.createElement('code');
    code.textContent = tag
      ? `${markup.trimEnd()} … ${view.state.sliceDoc(tag.closeFrom, tag.to).trimStart()}`
      : markup;
    dom.append(code);
    const retired = tag !== null && retiredColours.has(tag.name);
    if (retired) {
      const note = document.createElement('span');
      note.className = 'cm-symbol-retired';
      note.textContent = 'Retired';
      dom.append(note);
    }
    if (popover.source === 'selected' && !view.state.readOnly) {
      if (tag && retired) {
        // The same two fixes as the status bar's list, in the same order.
        const fixes: [string, () => void][] = [
          ['Remove tag (keep the text)', () => removeTag(view, tag)],
          ['Change to yellow', () => retagTag(view, tag, 'yellow')],
        ];
        for (const [label, run] of fixes) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'cm-symbol-fix';
          button.textContent = label;
          // A click must not take focus from the text: the fix keeps the caret in the editor.
          button.addEventListener('mousedown', (event) => event.preventDefault());
          button.addEventListener('click', () => {
            run();
            view.focus();
          });
          dom.append(button);
        }
      }
      const hint = document.createElement('span');
      hint.className = 'cm-symbol-hint';
      hint.textContent = tag
        ? 'Enter edit · Backspace remove tag'
        : 'Enter edit · Backspace remove';
      dom.append(hint);
    } else if (retired) {
      const hint = document.createElement('span');
      hint.className = 'cm-symbol-hint';
      hint.textContent = view.state.readOnly ? '' : 'Alt+click to fix';
      if (hint.textContent) dom.append(hint);
    }
  }
  return dom;
}

// The tooltip object stays the same while nothing about it changed, so its DOM (and an open input) is kept.
const symbolPopover = StateField.define<{ key: string; tooltip: Tooltip } | null>({
  create: () => null,
  update(value, transaction) {
    const popover = popoverFor(transaction.state);
    if (!popover) return null;
    const key = `${popover.source}:${popover.from}:${popover.to}:${popover.editing}`;
    if (value?.key === key) return value;
    const anchor = popover.at ?? popover.from;
    return {
      key,
      tooltip: {
        pos: anchor,
        end: popover.at === undefined ? popover.to : anchor,
        above: true,
        create: (view: EditorView) => ({ dom: popoverDom(view, popover) }),
      },
    };
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
});

const closestIn = (event: Event, selector: string) =>
  event.target instanceof Element ? event.target.closest(selector) : null;

const symbolEvents = EditorView.domEventHandlers({
  mouseover(event, view) {
    const symbol = closestIn(event, '.cm-symbol');
    if (symbol) {
      const from = view.posAtDOM(symbol);
      const found = findSymbols(view.state.doc.toString()).find((s) => s.from === from);
      if (found) view.dispatch({ effects: setHover.of({ from: found.from, to: found.to }) });
      return false;
    }
    if (closestIn(event, '.cm-tint')) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const tag = pos === null ? null : tagAt(view.state, pos);
      const current = view.state.field(hovered);
      if (tag && (current?.from !== tag.from || current.to !== tag.to)) {
        view.dispatch({
          effects: setHover.of({ from: tag.from, to: tag.to, at: pos ?? tag.openTo }),
        });
      }
    }
    return false;
  },
  mouseout(event, view) {
    const related = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    const leaving = closestIn(event, '.cm-symbol') ?? closestIn(event, '.cm-tint');
    // Moving between the nested pieces of one tinted run keeps the popover.
    if (leaving && !related?.closest('.cm-tint') && view.state.field(hovered)) {
      view.dispatch({ effects: setHover.of(null) });
    }
    return false;
  },
  mousedown(event, view) {
    if (event.button !== 0) return false;
    const symbol = closestIn(event, '.cm-symbol');
    if (symbol) {
      const from = view.posAtDOM(symbol);
      const found = findSymbols(view.state.doc.toString()).find((s) => s.from === from);
      if (!found) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: found.from, head: found.to } });
      view.focus();
      return true;
    }
    // Alt+click on tinted text selects the tag's enclosed text; the popover then edits or removes the tag.
    if (event.altKey && closestIn(event, '.cm-tint')) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const tag = pos === null ? null : tagAt(view.state, pos);
      if (!tag) return false;
      event.preventDefault();
      view.dispatch({
        selection: { anchor: tag.openTo, head: tag.closeFrom },
        effects: pinTag.of(true),
      });
      view.focus();
      return true;
    }
    return false;
  },
});

/** Removes a colour tag's markup and keeps the text it enclosed (selected afterwards). */
function removeTag(view: EditorView, tag: TagRange, effects: readonly StateEffect<unknown>[] = []) {
  view.dispatch({
    changes: [
      { from: tag.from, to: tag.openTo },
      { from: tag.closeFrom, to: tag.to },
    ],
    selection: { anchor: tag.from, head: tag.closeFrom - (tag.openTo - tag.from) },
    effects,
  });
}

/** Renames a colour tag in place (retired colour to yellow); the text it encloses stays selected. */
function retagTag(view: EditorView, tag: TagRange, name: string) {
  const next = `<${name} `;
  view.dispatch({
    changes: { from: tag.from, to: tag.openTo, insert: next },
    selection: {
      anchor: tag.from + next.length,
      head: tag.closeFrom - (tag.openTo - tag.from) + next.length,
    },
    effects: pinTag.of(true),
  });
}

/** A pinned colour tag: remove the markup, keep the text it enclosed. */
function removeSelectedTag(view: EditorView): boolean {
  if (view.state.readOnly || view.state.field(reveal) !== 'popover') return false;
  const tag = selectedTag(view.state);
  if (!tag) return false;
  removeTag(view, tag);
  return true;
}

/** Ctrl+Shift+. : shows every symbol as its markup, or draws them again. A listed reflow exception. */
export function toggleRawView(view: EditorView): boolean {
  view.dispatch({ effects: toggleRaw.of(!view.state.field(rawMode)) });
  return true;
}

/**
 * Alt+Enter: the keyboard twin of Alt+click. Pins the colour tag around the caret (or around a
 * selection inside one tag): its enclosed text is selected and the popover opens, where Enter edits
 * the tag and Backspace removes it. Without a tag there, the key falls through unhandled. Pressed
 * again while that tag is pinned it changes nothing, so an open edit input is never reset.
 */
export function pinTagAtCaret(view: EditorView): boolean {
  const { state } = view;
  if (state.field(rawMode) || state.field(reveal) !== 'popover') return false;
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  if (to > line.to) return false;
  const tag = findTags(line.text, line.from)
    .filter((t) => t.openTo <= from && to <= t.closeFrom)
    .pop();
  if (!tag) return false;
  if (selectedTag(state)?.from === tag.from) return true;
  view.dispatch({
    selection: { anchor: tag.openTo, head: tag.closeFrom },
    effects: pinTag.of(true),
    scrollIntoView: true,
  });
  return true;
}

const symbolKeys = keymap.of([
  {
    key: 'Enter',
    run(view) {
      if (view.state.readOnly || view.state.field(reveal) !== 'popover') return false;
      if (!selectedSymbol(view.state) && !selectedTag(view.state)) return false;
      view.dispatch({ effects: setEditing.of(true) });
      return true;
    },
  },
  { key: 'Backspace', run: removeSelectedTag },
  { key: 'Delete', run: removeSelectedTag },
  { key: 'Alt-Enter', run: pinTagAtCaret },
  { key: 'Mod-Shift-.', run: toggleRawView },
  { key: 'Mod-Shift->', run: toggleRawView },
]);

/**
 * The symbol widgets, tints, popover and keys. The reveal mode (device setting) and the raw toggle are
 * read when a state is built, so a new document keeps the user's choice.
 */
export function symbolExtensions(initial: { mode(): SymbolReveal; raw(): boolean }): Extension[] {
  return [
    rawMode.init(() => initial.raw()),
    reveal.init(() => initial.mode()),
    hovered,
    editing,
    tagPinned,
    symbolDecorations,
    symbolPopover,
    symbolEvents,
    symbolKeys,
    // Bound to the scroller so a line-1 popover flips below the line instead of covering the header.
    tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() }),
  ];
}

export function setSymbolReveal(view: EditorView, mode: SymbolReveal) {
  if (view.state.field(reveal) !== mode) view.dispatch({ effects: setReveal.of(mode) });
}
