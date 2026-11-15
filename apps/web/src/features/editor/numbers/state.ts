import { isolateHistory } from '@codemirror/commands';
import {
  Annotation,
  ChangeSet,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
  ViewPlugin,
} from '@codemirror/view';
import { numberTokenIssues, formatNumbers, type Lang } from '@clarity/core';
import {
  isStructureLine,
  scopedLines,
  sourceDeclarations,
  type NumberSource,
  type StructureLine,
} from './model';

export interface NumberHost {
  source: NumberSource | null;
  lang: Lang;
  changed?(state: EditorState): void;
  openPanel?(): void;
}
export const numberHost = Facet.define<NumberHost, NumberHost>({
  combine: (hosts) => hosts.at(-1) ?? { source: null, lang: 'en' },
});
class NumberWidget extends WidgetType {
  constructor(
    readonly id: number,
    readonly value: string,
    readonly status: string,
  ) {
    super();
  }
  eq(other: NumberWidget) {
    return this.id === other.id && this.value === other.value && this.status === other.status;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'clarity-number-token';
    span.dataset.numberId = String(this.id);
    if (this.status) span.dataset.severity = this.status;
    span.textContent = this.value;
    span.title =
      this.status === 'warning'
        ? 'Removed from English'
        : this.status === 'error'
          ? `Unknown number #{=${this.id}}`
          : `#{=${this.id}}`;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

interface Cycle {
  base: EditorState;
  inverse: ChangeSet;
  candidates: readonly number[];
  index: number;
  id: number;
  from: number;
  to: number;
}
export interface NumberState {
  decorations: DecorationSet;
  structure: readonly StructureLine[];
  cycle: Cycle | null;
  dismissed: string | null;
  message: string;
  placed: boolean;
}
const cycleChange = Annotation.define<Cycle | null>();
const dismiss = StateEffect.define<string>();
const message = StateEffect.define<string>();
export const numbersReload = StateEffect.define<null>();

function scan(
  state: EditorState,
  from: number,
  to: number,
  ranges: Range<Decoration>[],
  lines: StructureLine[],
) {
  const host = state.facet(numberHost);
  const source = host.source;
  if (!source) return;
  let line = state.doc.lineAt(from);
  while (line.from <= to) {
    if (isStructureLine(line.text)) lines.push({ from: line.from, to: line.to, text: line.text });
    for (const match of line.text.matchAll(/#\{=([1-9]\d*)\}/g)) {
      const id = Number(match[1]);
      const raw = source.values.get(id);
      const value = typeof raw === 'string' ? formatNumbers(raw, host.lang) : '?';
      const status = !source.values.has(id) ? 'error' : source.retired.has(id) ? 'warning' : '';
      ranges.push(
        Decoration.replace({
          widget: new NumberWidget(id, source.byId.get(id)?.display ?? value, status),
          numberId: id,
        }).range(line.from + match.index, line.from + match.index + match[0].length),
      );
    }
    if (line.to === state.doc.length) break;
    line = state.doc.line(line.number + 1);
  }
}
function initial(state: EditorState): NumberState {
  const ranges: Range<Decoration>[] = [],
    structure: StructureLine[] = [];
  scan(state, 0, state.doc.length, ranges, structure);
  return {
    decorations: Decoration.set(ranges, true),
    structure,
    cycle: null,
    dismissed: null,
    message: '',
    placed: false,
  };
}

export const numberField = StateField.define<NumberState>({
  create: initial,
  update(value, tr) {
    if (tr.reconfigured || tr.effects.some((effect) => effect.is(numbersReload)))
      return initial(tr.state);
    let decorations = value.decorations.map(tr.changes);
    let structure = value.structure;
    if (tr.docChanged) {
      const touched: { from: number; to: number }[] = [];
      tr.changes.iterChangedRanges((_a, _b, from, to) => {
        const range = { from: tr.state.doc.lineAt(from).from, to: tr.state.doc.lineAt(to).to };
        const last = touched.at(-1);
        if (last && last.to >= range.from - 1) last.to = Math.max(last.to, range.to);
        else touched.push(range);
      });
      const ranges: Range<Decoration>[] = [],
        lines: StructureLine[] = [];
      for (const range of touched) scan(tr.state, range.from, range.to, ranges, lines);
      decorations = decorations.update({
        filter: (from, to) => !touched.some((range) => from <= range.to && to >= range.from),
        add: ranges,
        sort: true,
      });
      structure = [
        ...structure
          .map((line) => ({
            ...line,
            from: tr.changes.mapPos(line.from, -1),
            to: tr.changes.mapPos(line.to, 1),
          }))
          .filter(
            (line) => !touched.some((range) => line.from <= range.to && line.to >= range.from),
          ),
        ...lines,
      ].sort((a, b) => a.from - b.from);
    }
    const cycle = tr.annotation(cycleChange);
    let next: NumberState = {
      decorations,
      structure,
      cycle: cycle === undefined ? (tr.docChanged || tr.selection ? null : value.cycle) : cycle,
      dismissed: tr.docChanged || tr.selection ? null : value.dismissed,
      message: tr.docChanged || tr.selection ? '' : value.message,
      placed: value.placed || Boolean(tr.selection),
    };
    for (const effect of tr.effects) {
      if (effect.is(dismiss)) next = { ...next, dismissed: effect.value };
      if (effect.is(message)) next = { ...next, message: effect.value };
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (state) => state.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

export function usedNumbers(state: EditorState) {
  const used = new Set<number>();
  let previous: number | undefined;
  const head = state.selection.main.from;
  state.field(numberField).decorations.between(0, state.doc.length, (from, to, decoration) => {
    const id = decoration.spec.numberId as number;
    used.add(id);
    if (to <= head) previous = id;
  });
  return { used, previous };
}
export function orderedNumbers(state: EditorState, includeUsed = false): number[] {
  const source = state.facet(numberHost).source;
  if (!source) return [];
  const { used, previous } = usedNumbers(state);
  const index = source.slots.findIndex((slot) => slot.id === previous);
  const slots = [...source.slots.slice(index + 1), ...source.slots.slice(0, index + 1)];
  return slots.filter((slot) => includeUsed || !used.has(slot.id)).map((slot) => slot.id);
}

/** Check only the current line, using the same structural refusal as core validation. */
export function numbersAllowed(
  state: EditorState,
  from = state.selection.main.from,
  to = state.selection.main.to,
) {
  if (state.readOnly || !state.facet(numberHost).source) return false;
  const start = state.doc.lineAt(from),
    end = state.doc.lineAt(to);
  const text = state.doc.sliceString(start.from, end.to);
  const token = '#{=1}';
  const proposed = text.slice(0, from - start.from) + token + text.slice(to - start.from);
  return !numberTokenIssues(proposed, state.facet(numberHost).lang).some(
    (issue) => issue.from === from - start.from,
  );
}

function insertion(
  state: EditorState,
  id: number,
  from = state.selection.main.from,
  to = state.selection.main.to,
) {
  const source = state.facet(numberHost).source!;
  const slot = source.byId.get(id)!;
  const structure = scopedLines(state.field(numberField).structure);
  const declarations = sourceDeclarations(source).filter((declaration) =>
    slot.variables.includes(declaration.name),
  );
  const additions = new Map<number, string>();
  const missingBlocks = new Map<string, { lines: string[]; at: number }>();
  for (const declaration of declarations) {
    if (
      structure.some(
        (line) =>
          line.scope === declaration.scope && line.text.startsWith(`var ${declaration.name} = `),
      )
    )
      continue;
    const close = structure.find(
      (line) => line.scope === declaration.scope && /^\s*\)/.test(line.text),
    );
    if (declaration.scope && !close) {
      let at = state.doc.length;
      state.field(numberField).decorations.between(0, state.doc.length, (from, _to, decoration) => {
        if (declaration.following.includes(decoration.spec.numberId as number))
          at = Math.min(at, state.doc.lineAt(from).from);
      });
      const list = missingBlocks.get(declaration.scope) ?? { lines: [], at };
      list.lines.push(declaration.text);
      missingBlocks.set(declaration.scope, list);
    } else {
      const at = close?.from ?? state.doc.length;
      const prefix = at === state.doc.length && at > 0 ? '\n' : '';
      additions.set(at, (additions.get(at) ?? prefix) + declaration.text + '\n');
    }
  }
  for (const [scope, { lines, at }] of missingBlocks) {
    const block = scope.split('\n');
    additions.set(
      at,
      (additions.get(at) ?? (at > 0 ? '\n' : '')) +
        block.join('\n') +
        '\n' +
        lines.join('\n') +
        '\n' +
        block.map(() => ')').join('\n') +
        (at < state.doc.length ? '\n' : ''),
    );
  }
  const token = `#{=${id}}`;
  // Declarations at the caret's end go after its token, in the same change.
  const tail = additions.get(to);
  if (tail !== undefined) additions.delete(to);
  const changes = ChangeSet.of(
    [
      {
        from,
        to,
        insert: token + (tail === undefined ? '' : tail.startsWith('\n') ? tail : '\n' + tail),
      },
      ...[...additions].map(([from, insert]) => ({ from, insert })),
    ].sort((a, b) => a.from - b.from),
    state.doc.length,
  );
  return { changes, selection: { anchor: changes.mapPos(from, -1) + token.length } };
}

export function insertNumber(
  view: EditorView,
  id: number,
  convert?: { from: number; to: number },
  cycling = false,
): boolean {
  if (
    !view.state.facet(numberHost).source?.byId.has(id) ||
    !numbersAllowed(view.state, convert?.from, convert?.to)
  )
    return false;
  const base = view.state;
  const plan = insertion(base, id, convert?.from, convert?.to);
  const candidates = orderedNumbers(base, Boolean(convert)).filter(
    (candidate) =>
      !convert ||
      base.facet(numberHost).source!.byId.get(candidate)!.display ===
        base.facet(numberHost).source!.byId.get(id)!.display,
  );
  const cycle = cycling
    ? {
        base,
        inverse: plan.changes.invert(base.doc),
        candidates,
        index: Math.max(0, candidates.indexOf(id)),
        id,
        from: convert?.from ?? base.selection.main.from,
        to: convert?.to ?? base.selection.main.to,
      }
    : null;
  view.dispatch({
    ...plan,
    annotations: [
      cycleChange.of(cycle),
      isolateHistory.of(cycling ? 'before' : 'full'),
      Transaction.userEvent.of('input.number'),
    ],
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Pane and toolbar insertion retain an existing selection; the untouched caret starts at end. */
export function insertSourceNumber(view: EditorView, id: number): boolean {
  return insertNumber(
    view,
    id,
    view.state.field(numberField).placed
      ? undefined
      : { from: view.state.doc.length, to: view.state.doc.length },
  );
}

export function tabNumber(view: EditorView, direction = 1): boolean {
  const state = view.state;
  if (!state.facet(numberHost).source) return false;
  const cycle = state.field(numberField).cycle;
  if (cycle && cycle.candidates.length) {
    const index = (cycle.index + direction + cycle.candidates.length) % cycle.candidates.length;
    const id = cycle.candidates[index];
    const plan = insertion(cycle.base, id, cycle.from, cycle.to);
    const changes = cycle.inverse.compose(plan.changes);
    view.dispatch({
      changes,
      selection: plan.selection,
      annotations: [
        cycleChange.of({ ...cycle, inverse: plan.changes.invert(cycle.base.doc), index, id }),
        // CodeMirror explicitly joins compose continuations, independent of its 500ms window.
        Transaction.userEvent.of('input.type.compose'),
      ],
      scrollIntoView: true,
    });
    return true;
  }
  if (direction < 0) return true;
  const offer = typedNumberOffer(state);
  if (offer) return insertNumber(view, offer.ids[0], offer, true);
  if (!numbersAllowed(state)) {
    view.dispatch({ effects: message.of("Numbers can't go here") });
    return true;
  }
  const next = orderedNumbers(state)[0];
  if (next === undefined) {
    view.dispatch({ effects: message.of('All numbers used') });
    return true;
  }
  return insertNumber(view, next, undefined, true);
}

export function numberExtension(): Extension {
  return [
    numberField,
    ViewPlugin.fromClass(
      class {
        constructor(view: EditorView) {
          view.state.facet(numberHost).changed?.(view.state);
        }
        update(update: {
          state: EditorState;
          docChanged: boolean;
          selectionSet: boolean;
          transactions: readonly Transaction[];
        }) {
          if (
            update.docChanged ||
            update.selectionSet ||
            update.transactions.some((tr) => tr.effects.length || tr.reconfigured)
          )
            update.state.facet(numberHost).changed?.(update.state);
        }
      },
    ),
    EditorState.transactionExtender.of((tr) =>
      tr.startState.field(numberField).cycle &&
      (tr.docChanged || tr.selection) &&
      tr.annotation(cycleChange) === undefined
        ? { annotations: isolateHistory.of('before') }
        : null,
    ),
    EditorView.baseTheme({
      '.clarity-number-token': {
        background: 'var(--var-tint)',
        border: '1px solid var(--line)',
        padding: '0 2px',
        font: 'inherit',
      },
      '.clarity-number-token[data-severity=warning]': { borderColor: 'var(--diag-warn)' },
      '.clarity-number-token[data-severity=error]': { borderColor: 'var(--diag-error)' },
    }),
  ];
}

export interface NumberOffer {
  from: number;
  to: number;
  ids: readonly number[];
  key: string;
  value: string;
}
export function typedNumberOffer(state: EditorState): NumberOffer | null {
  const source = state.facet(numberHost).source;
  if (!source || state.readOnly || !state.selection.main.empty || state.field(numberField).cycle)
    return null;
  const head = state.selection.main.head,
    line = state.doc.lineAt(head);
  const before = state.doc.sliceString(Math.max(line.from, head - source.longest - 1), head);
  const match = /[-+]?\d[\d.,| %]*\??$/.exec(before);
  if (!match || (match.index && /[\p{L}\p{N}_#]/u.test(before[match.index - 1]))) return null;
  const ids = source.byDisplay.get(match[0]);
  if (!ids || /[\p{L}\p{N}_.]/u.test(state.doc.sliceString(head, Math.min(head + 1, line.to))))
    return null;
  const from = head - match[0].length,
    key = `${from}:${head}:${match[0]}`;
  if (state.field(numberField).dismissed === key || !numbersAllowed(state, from, head)) return null;
  const ordered = orderedNumbers(state, true).filter((id) => ids.includes(id));
  return { from, to: head, key, ids: ordered, value: match[0] };
}
export function dismissNumberOffer(view: EditorView): boolean {
  const offer = typedNumberOffer(view.state);
  if (!offer) return false;
  view.dispatch({ effects: dismiss.of(offer.key) });
  return true;
}

export interface NumberSnapshot {
  source: NumberSource | null;
  used: ReadonlySet<number>;
  next?: number;
  cycle?: number;
  offer: NumberOffer | null;
  message: string;
  empty: boolean;
}
export function createNumberStore() {
  let value: NumberSnapshot = {
    source: null,
    used: new Set(),
    offer: null,
    message: '',
    empty: true,
  };
  let key = '';
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed(state: EditorState) {
      const source = state.facet(numberHost).source,
        field = state.field(numberField);
      const { used } = usedNumbers(state);
      const next = orderedNumbers(state)[0],
        offer = typedNumberOffer(state),
        cycle = field.cycle?.id;
      const empty = state.doc.length === 0;
      const nextKey = JSON.stringify([[...used], next, offer?.key, cycle, field.message, empty]);
      if (source === value.source && nextKey === key) return;
      key = nextKey;
      value = { source, used, next, cycle, offer, message: field.message, empty };
      for (const listener of listeners) listener();
    },
  };
}
export type NumberStore = ReturnType<typeof createNumberStore>;
