import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
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
import { markupIcons } from '@clarity/core';
import previewStyles from '../preview/TooltipPreview.module.scss';
import type { SymbolReveal } from '../../stores/settings';

/**
 * Symbol widgets: an icon tag (`<arc/>`) or the opening/closing of a colour tag (`<yellow ` … ` />`)
 * is drawn as one fixed-width symbol. The document is never changed by drawing: the widgets only
 * replace what is shown, and search, spellcheck and copy all work on the raw text.
 */
export const symbolColours = ['yellow', 'blue', 'green', 'purple', 'pve', 'pvp', 'bold'] as const;
const icons: ReadonlySet<string> = new Set(markupIcons);
const colours: ReadonlySet<string> = new Set(symbolColours);

export interface SymbolRange {
  from: number;
  to: number;
  kind: 'icon' | 'open' | 'close';
  /** The icon or colour name (the same names the markup row uses). */
  name: string;
}

/** Finds every symbol in a text. Colour tags are paired per line, so a stray ` />` is left raw. */
export function findSymbols(text: string, offset = 0): SymbolRange[] {
  const found: SymbolRange[] = [];
  let lineFrom = offset;
  for (const line of text.split('\n')) {
    const stack: string[] = [];
    for (const match of line.matchAll(/<(\w+)\/>|<(\w+) | ?\/>/g)) {
      const from = lineFrom + (match.index ?? 0);
      const to = from + match[0].length;
      if (match[1] !== undefined) {
        if (icons.has(match[1])) found.push({ from, to, kind: 'icon', name: match[1] });
      } else if (match[2] !== undefined) {
        stack.push(match[2]);
        if (colours.has(match[2])) found.push({ from, to, kind: 'open', name: match[2] });
      } else {
        const name = stack.pop();
        if (name && colours.has(name)) found.push({ from, to, kind: 'close', name });
      }
    }
    lineFrom += line.length + 1;
  }
  return found;
}

class SymbolWidget extends WidgetType {
  constructor(
    readonly kind: SymbolRange['kind'],
    readonly name: string,
  ) {
    super();
  }
  eq(other: SymbolWidget) {
    return other.kind === this.kind && other.name === this.name;
  }
  toDOM() {
    const element = document.createElement('span');
    element.className = `cm-symbol cm-symbol-${this.kind}`;
    element.setAttribute('aria-hidden', 'true');
    element.dataset.symbol = this.name;
    // The icon classes are the preview's own, so the light theme's outlined copies come along.
    if (this.kind === 'icon') element.classList.add(previewStyles[this.name] ?? '');
    else element.dataset.colour = this.name;
    return element;
  }
  ignoreEvent() {
    return false;
  }
}

export const toggleRaw = StateEffect.define<boolean>();
/** Document-wide raw view: the widgets go away and the markup shows as it is stored. */
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

interface Popover {
  from: number;
  to: number;
  /** Where it came from: the pointer (hover) or a selected symbol (pinned, can be edited). */
  source: 'hover' | 'selected';
  editing: boolean;
}
const setHover = StateEffect.define<{ from: number; to: number } | null>();
const setEditing = StateEffect.define<boolean>();

const hovered = StateField.define<{ from: number; to: number } | null>({
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

/** The symbol range that is exactly the selection (a symbol chosen with a click or the arrows). */
function selectedSymbol(state: EditorState): SymbolRange | null {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  return findSymbols(state.doc.toString()).find((s) => s.from === from && s.to === to) ?? null;
}

function build(state: EditorState): DecorationSet {
  if (state.field(rawMode)) return Decoration.none;
  const text = state.doc.toString();
  const caret = state.field(reveal) === 'caret';
  const ranges = findSymbols(text).filter(
    (symbol) =>
      !caret || !state.selection.ranges.some((r) => r.from <= symbol.to && r.to >= symbol.from),
  );
  return Decoration.set(
    ranges.map((symbol) =>
      Decoration.replace({ widget: new SymbolWidget(symbol.kind, symbol.name) }).range(
        symbol.from,
        symbol.to,
      ),
    ),
    true,
  );
}

const symbolDecorations = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    const changed =
      transaction.docChanged ||
      transaction.startState.field(rawMode) !== transaction.state.field(rawMode) ||
      transaction.startState.field(reveal) !== transaction.state.field(reveal) ||
      (transaction.state.field(reveal) === 'caret' && transaction.selection !== undefined);
    return changed ? build(transaction.state) : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

function popoverFor(state: EditorState): Popover | null {
  if (state.field(rawMode) || state.field(reveal) !== 'popover') return null;
  const selected = selectedSymbol(state);
  if (selected) {
    return {
      from: selected.from,
      to: selected.to,
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
  const markup = view.state.sliceDoc(popover.from, popover.to);
  if (popover.editing) {
    const input = document.createElement('input');
    input.className = 'cm-symbol-input';
    input.value = markup;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Symbol markup');
    const finish = (commit: boolean) => {
      const next = input.value;
      view.dispatch({
        effects: setEditing.of(false),
        ...(commit && next !== markup
          ? {
              changes: { from: popover.from, to: popover.to, insert: next },
              selection: { anchor: popover.from + next.length },
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
    code.textContent = markup;
    dom.append(code);
    if (popover.source === 'selected' && !view.state.readOnly) {
      const hint = document.createElement('span');
      hint.className = 'cm-symbol-hint';
      hint.textContent = 'Enter edit · Backspace remove';
      dom.append(hint);
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
    return {
      key,
      tooltip: {
        pos: popover.from,
        end: popover.to,
        above: true,
        create: (view: EditorView) => ({ dom: popoverDom(view, popover) }),
      },
    };
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
});

const symbolEvents = EditorView.domEventHandlers({
  mouseover(event, view) {
    const target = event.target instanceof Element ? event.target.closest('.cm-symbol') : null;
    if (!target) return false;
    const from = view.posAtDOM(target);
    const found = findSymbols(view.state.doc.toString()).find((s) => s.from === from);
    if (found) view.dispatch({ effects: setHover.of({ from: found.from, to: found.to }) });
    return false;
  },
  mouseout(event, view) {
    const target = event.target instanceof Element ? event.target.closest('.cm-symbol') : null;
    if (target && view.state.field(hovered)) view.dispatch({ effects: setHover.of(null) });
    return false;
  },
  mousedown(event, view) {
    const target = event.target instanceof Element ? event.target.closest('.cm-symbol') : null;
    if (!target || event.button !== 0) return false;
    const from = view.posAtDOM(target);
    const found = findSymbols(view.state.doc.toString()).find((s) => s.from === from);
    if (!found) return false;
    event.preventDefault();
    view.dispatch({ selection: { anchor: found.from, head: found.to } });
    view.focus();
    return true;
  },
});

const symbolKeys = keymap.of([
  {
    key: 'Enter',
    run(view) {
      if (view.state.readOnly || view.state.field(reveal) !== 'popover') return false;
      if (!selectedSymbol(view.state)) return false;
      view.dispatch({ effects: setEditing.of(true) });
      return true;
    },
  },
  {
    key: 'Mod-Shift-.',
    run: toggleRawView,
  },
  { key: 'Mod-Shift->', run: toggleRawView },
]);

/** Ctrl+Shift+. : shows every symbol as its markup, or draws them again. A listed reflow exception. */
export function toggleRawView(view: EditorView): boolean {
  view.dispatch({ effects: toggleRaw.of(!view.state.field(rawMode)) });
  return true;
}

/**
 * The symbol widgets, popover and keys. The reveal mode (device setting) and the raw toggle are read
 * when a state is built, so a new document keeps the user's choice.
 */
export function symbolExtensions(initial: { mode(): SymbolReveal; raw(): boolean }): Extension[] {
  return [
    rawMode.init(() => initial.raw()),
    reveal.init(() => initial.mode()),
    hovered,
    editing,
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
