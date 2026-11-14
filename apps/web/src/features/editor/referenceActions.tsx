import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type TransactionSpec,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import { enhancedArrowMarkup, mergedVariable, type Lang, type MarkupGlobals } from '@clarity/core';
import { ReferencePopover } from './ReferencePopover';
import { drawnSymbolAt, findSymbols } from './symbols';
import {
  isInComment,
  localDefinitions,
  referenceInLine,
  resolveReference,
  sourcesFromGlobals,
  type LineReference,
  type ReferenceSources,
  type ReferenceTarget,
  type ResolvedReference,
} from './references';

export type TooltipTarget = Extract<ReferenceTarget, { type: 'tooltip' }>;

export interface ReferenceHost {
  lang: Lang;
  globals: MarkupGlobals;
  /** Read at use time so editing never reconfigures the editor. */
  sources: () => ReferenceSources | undefined;
  selfHash: () => number | undefined;
  navigate: () => ((target: TooltipTarget) => void) | undefined;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const openShortcut = isMac ? 'F12 · ⌘Click' : 'F12 · Ctrl+Click';

function modifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/** Whether `range` is exactly a symbol's markup (the legacy arrow `#e`). */
function symbolRange(state: EditorState, range: { from: number; to: number }): boolean {
  const line = state.doc.lineAt(range.from);
  return findSymbols(line.text, line.from).some(
    (symbol) => symbol.from === range.from && symbol.to === range.to,
  );
}

/** The reference touching `pos`, ignoring comments. Offsets are document offsets. */
export function referenceAtPosition(
  doc: Text,
  pos: number,
  side = 0,
): (LineReference & { range: { from: number; to: number } }) | null {
  const line = doc.lineAt(pos);
  const found = referenceInLine(line.text, pos - line.from);
  if (!found) return null;
  const range = { from: line.from + found.from, to: line.from + found.to };
  if ((range.from === pos && side < 0) || (range.to === pos && side > 0)) return null;
  return isInComment(doc.toString(), range.from, range.to) ? null : { ...found, range };
}

/** Selection-only move to a definition in the open document; the text is never touched. */
export function localTargetTransaction(
  target: Extract<ReferenceTarget, { type: 'local' }>,
): TransactionSpec {
  return {
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    userEvent: 'select.definition',
  };
}

export function canOpen(resolved: ResolvedReference, host: Pick<ReferenceHost, 'navigate'>) {
  const target = resolved.target;
  return (
    resolved.status === 'found' &&
    target !== undefined &&
    (target.type === 'local' || host.navigate() !== undefined)
  );
}

export function openDefinition(
  view: EditorView,
  resolved: ResolvedReference,
  host: Pick<ReferenceHost, 'navigate'>,
): boolean {
  const target = resolved.target;
  if (!target || !canOpen(resolved, host)) return false;
  if (target.type === 'local') {
    view.dispatch(localTargetTransaction(target));
    view.focus();
  } else host.navigate()?.(target);
  return true;
}

function renderGlobals(host: ReferenceHost, doc: string): MarkupGlobals {
  const local = localDefinitions(doc);
  return {
    ...host.globals,
    variables: [local.variables, host.globals.variables].filter(Boolean).join('\n'),
    titles: [local.titles, host.globals.titles].filter(Boolean).join('\n\n'),
  };
}

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const showReference = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'clarity-reference-link' });

export function referenceExtensions(host: ReferenceHost): Extension {
  const cache = new WeakMap<Text, Map<string, ResolvedReference>>();
  const resolve = (state: EditorState, ref: LineReference): ResolvedReference => {
    const key = `${ref.kind}:${ref.name}:${ref.source ?? ''}`;
    let byDoc = cache.get(state.doc);
    if (!byDoc) cache.set(state.doc, (byDoc = new Map()));
    let resolved = byDoc.get(key);
    if (!resolved) {
      resolved = resolveReference(ref, {
        doc: state.doc.toString(),
        lang: host.lang,
        globals: host.globals,
        sources: host.sources() ?? sourcesFromGlobals(host.globals, host.lang),
        selfHash: host.selfHash(),
      });
      byDoc.set(key, resolved);
    }
    return resolved;
  };

  /**
   * `#dx` with only `var d`: the plain reference merges d with the text after it. The fix writes
   * the delimited `#{d}x` (or `<enhanced/>x` for the arrow e), in place, as one undoable change.
   */
  const mergeFix = (
    view: EditorView,
    found: LineReference & { range: { from: number; to: number } },
    resolved: ResolvedReference,
  ) => {
    if (found.kind !== 'variable' || found.braced || resolved.status !== 'missing') return;
    const state = view.state;
    const merged = mergedVariable(
      found.name,
      (name) => resolve(state, { ...found, name }).status === 'found',
    );
    if (merged === undefined || view.state.readOnly) return;
    const rest = found.name.slice(merged.length);
    const insert = merged === 'e' ? `${enhancedArrowMarkup}${rest}` : `#{${merged}}${rest}`;
    const source = state.sliceDoc(found.range.from, found.range.to);
    return {
      message:
        merged === 'e'
          ? 'The enhanced arrow #e merges with the text after it.'
          : `Variable #${merged} merges with the text after it.`,
      label: `Write ${insert}`,
      onApply: () => {
        if (view.state.sliceDoc(found.range.from, found.range.to) === source)
          view.dispatch({
            changes: { from: found.range.from, to: found.range.to, insert },
            userEvent: 'input.fix',
          });
        view.focus();
      },
    };
  };

  const build = (
    view: EditorView,
    found: LineReference & { range: { from: number; to: number } },
    announce: boolean,
  ) => {
    const resolved = resolve(view.state, found);
    const dom = document.createElement('div');
    dom.className = 'clarity-reference-popover';
    if (announce) dom.setAttribute('role', 'status');
    const root = createRoot(dom);
    const doc = view.state.doc.toString();
    const fix = mergeFix(view, found, resolved);
    flushSync(() =>
      root.render(
        <ReferencePopover
          resolved={resolved}
          lang={host.lang}
          globals={renderGlobals(host, doc)}
          openShortcut={openShortcut}
          fix={fix}
          onOpen={
            canOpen(resolved, host)
              ? () => {
                  openDefinition(view, resolved, host);
                }
              : undefined
          }
        />,
      ),
    );
    return { dom, destroy: () => queueMicrotask(() => root.unmount()) };
  };

  const tooltipFor = (state: EditorState, pos: number, side: number): Tooltip | null => {
    const found = referenceAtPosition(state.doc, pos, side);
    if (!found) return null;
    return {
      pos: found.range.from,
      end: found.range.to,
      above: true,
      create: (view) => build(view, found, side === 0),
    };
  };

  /** Keyboard and tap: the same popover, pinned until the caret or text moves. */
  const pinned = StateField.define<Tooltip | null>({
    create: () => null,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(showReference)) {
          return effect.value ? tooltipFor(transaction.state, effect.value.from, 0) : null;
        }
      }
      return value && (transaction.docChanged || transaction.selection) ? null : value;
    },
    provide: (field) => showTooltip.from(field),
  });

  const link = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(setLink)) {
          return effect.value
            ? Decoration.set([linkMark.range(effect.value.from, effect.value.to)])
            : Decoration.none;
        }
      }
      return transaction.docChanged ? Decoration.none : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  /** While Ctrl/Cmd is held, underline the reference under the pointer if it can be opened. */
  const linkHints = ViewPlugin.fromClass(
    class {
      held = false;
      pointer: { x: number; y: number } | null = null;
      shown: { from: number; to: number } | null = null;
      constructor(readonly view: EditorView) {
        window.addEventListener('keydown', this.onKey);
        window.addEventListener('keyup', this.onKey);
        window.addEventListener('blur', this.onBlur);
        view.dom.addEventListener('mousemove', this.onMove);
        view.dom.addEventListener('mouseleave', this.onLeave);
      }
      /** Only a change of the held state refreshes: posAtCoords forces a layout, and
       * every Ctrl shortcut (and key repeat) would otherwise pay for one per keydown. */
      onKey = (event: KeyboardEvent) => {
        const held = modifierHeld(event);
        if (held === this.held) return;
        this.held = held;
        this.refresh();
      };
      onBlur = () => {
        if (!this.held && !this.shown) return;
        this.held = false;
        this.refresh();
      };
      onMove = (event: MouseEvent) => {
        this.held = modifierHeld(event);
        this.pointer = { x: event.clientX, y: event.clientY };
        this.refresh();
      };
      onLeave = () => {
        this.pointer = null;
        this.refresh();
      };
      update(update: ViewUpdate) {
        // The link field drops its mark on any edit; forget it so the next refresh re-shows it.
        if (update.docChanged) this.shown = null;
      }
      refresh() {
        let next: { from: number; to: number } | null = null;
        if (this.held && this.pointer) {
          const pos = this.view.posAtCoords(this.pointer);
          const found = pos === null ? null : referenceAtPosition(this.view.state.doc, pos, 0);
          if (found && canOpen(resolve(this.view.state, found), host)) next = found.range;
        }
        if (next?.from === this.shown?.from && next?.to === this.shown?.to) return;
        this.shown = next;
        this.view.dispatch({ effects: setLink.of(next) });
      }
      destroy() {
        window.removeEventListener('keydown', this.onKey);
        window.removeEventListener('keyup', this.onKey);
        window.removeEventListener('blur', this.onBlur);
        this.view.dom.removeEventListener('mousemove', this.onMove);
        this.view.dom.removeEventListener('mouseleave', this.onLeave);
      }
    },
  );

  /** F12 / Ctrl+Click: open when possible; otherwise the popover says why not. */
  const goTo = (view: EditorView, pos: number): boolean => {
    const found = referenceAtPosition(view.state.doc, pos, 0);
    if (!found) return false;
    const resolved = resolve(view.state, found);
    if (openDefinition(view, resolved, host)) return true;
    view.dispatch({ effects: showReference.of(found.range) });
    return true;
  };

  return [
    pinned,
    link,
    linkHints,
    hoverTooltip(
      (view, pos, side) =>
        drawnSymbolAt(view.state, pos) ? null : tooltipFor(view.state, pos, side),
      {
        hideOnChange: true,
        hoverTime: 300,
      },
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !modifierHeld(event)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null || !referenceAtPosition(view.state.doc, pos, 0)) return false;
        event.preventDefault();
        return goTo(view, pos);
      },
      click(event, view) {
        // Touch has no hover: a tap on a reference pins the popover (with its Open button).
        if (modifierHeld(event) || !window.matchMedia?.('(pointer: coarse)').matches) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const found = pos === null ? null : referenceAtPosition(view.state.doc, pos, 0);
        // The legacy arrow `#e` is a symbol: its own popover (Old spelling) answers the tap.
        if (found && !symbolRange(view.state, found.range))
          view.dispatch({ effects: showReference.of(found.range) });
        return false;
      },
    }),
    keymap.of([
      {
        key: 'F12',
        run: (view) => goTo(view, view.state.selection.main.head),
      },
      {
        key: 'Mod-k Mod-i',
        run(view) {
          const found = referenceAtPosition(view.state.doc, view.state.selection.main.head, 0);
          if (!found) return false;
          view.dispatch({ effects: showReference.of(found.range) });
          return true;
        },
      },
      {
        key: 'Escape',
        run(view) {
          if (!view.state.field(pinned)) return false;
          view.dispatch({ effects: showReference.of(null) });
          return true;
        },
      },
    ]),
  ];
}
