import { EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';

/**
 * Tab stops left over after a snippet is inserted. The first stop is selected by the insertion;
 * Tab and Shift+Tab move between the rest, and Esc, an edit elsewhere, or Tab past the last one
 * ends it. The stops are marked with a background and underline only (no padding or border), so
 * the text they sit in never moves.
 */
export interface StopRange {
  from: number;
  to: number;
}
interface Stops {
  ranges: StopRange[];
  active: number;
}

export const setStops = StateEffect.define<StopRange[]>();
const clearStops = StateEffect.define<null>();
const activateStop = StateEffect.define<number>();

export const stopsField = StateField.define<Stops | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setStops)) {
        return effect.value.length > 1 ? { ranges: effect.value, active: 0 } : null;
      }
      if (effect.is(clearStops)) return null;
    }
    if (!value) return value;
    const activated = transaction.effects.find((effect) => effect.is(activateStop));
    const active = activated ? (activated.value as number) : value.active;
    const ranges = transaction.docChanged
      ? value.ranges.map((range) => ({
          from: transaction.changes.mapPos(range.from, -1),
          to: transaction.changes.mapPos(range.to, 1),
        }))
      : value.ranges;
    // Selecting somewhere outside every stop means the author has moved on.
    const main = transaction.state.selection.main;
    const inside = ranges.some((range) => main.from >= range.from && main.to <= range.to);
    return inside ? { ranges, active } : null;
  },
});

function go(view: EditorView, step: 1 | -1): boolean {
  const stops = view.state.field(stopsField, false);
  if (!stops) return false;
  const next = stops.active + step;
  const target = stops.ranges[next];
  if (!target) {
    // Past the last stop: finish where that stop ends.
    const last = stops.ranges[stops.ranges.length - 1]!;
    view.dispatch({
      selection: EditorSelection.cursor(last.to),
      effects: clearStops.of(null),
      scrollIntoView: true,
    });
    return step === 1;
  }
  view.dispatch({
    selection: EditorSelection.range(target.from, target.to),
    effects: activateStop.of(next),
    scrollIntoView: true,
  });
  return true;
}

export function stopsExtension(): Extension {
  return [
    stopsField,
    EditorView.decorations.from(stopsField, (stops) =>
      stops
        ? Decoration.set(
            stops.ranges
              .filter((range) => range.to > range.from)
              .map((range) =>
                Decoration.mark({ class: 'cm-suggestStop' }).range(range.from, range.to),
              ),
            true,
          )
        : Decoration.none,
    ),
    Prec.high(
      keymap.of([
        { key: 'Tab', run: (view) => go(view, 1) },
        { key: 'Shift-Tab', run: (view) => go(view, -1) },
        {
          key: 'Escape',
          run: (view) => {
            if (!view.state.field(stopsField, false)) return false;
            view.dispatch({ effects: clearStops.of(null) });
            return true;
          },
        },
      ]),
    ),
  ];
}
