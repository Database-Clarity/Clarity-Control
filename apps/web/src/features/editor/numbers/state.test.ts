// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { deleteCharBackward, history, undo } from '@codemirror/commands';
import { numberSource, tokenizedEnglish } from './model';
import { missingNumberVariables } from './diagnostics';
import {
  dismissNumberOffer,
  insertNumber,
  numberExtension,
  numberField,
  numberHost,
  orderedNumbers,
  tabNumber,
  typedNumberOffer,
  convertTypedNumbers,
  insertSourceNumber,
} from './state';

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});
function editor(english: string, doc = '') {
  const source = numberSource(english, undefined, 'de');
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [history(), numberHost.of({ source, lang: 'de' }), numberExtension()],
    }),
  });
  views.push(view);
  return view;
}
const text = (view: EditorView) => view.state.doc.toString();

it('inserts transitive local variables with the formula in one undo and without W7', () => {
  const english = 'var a = 2\nvar d = #a\nDamage ${5+#d}.';
  const view = editor(english);
  insertNumber(view, 2);
  expect(text(view)).toContain('var a = #{=1}');
  expect(text(view)).toContain('var d = #a');
  expect(missingNumberVariables(text(view), english, undefined, 'de')).toEqual([]);
  undo(view);
  expect(text(view)).toBe('');
});

it('inserts source clicks at the end before caret placement and then retains selections', () => {
  const view = editor('Value 5.', 'Word');
  expect(insertSourceNumber(view, 1)).toBe(true);
  expect(text(view)).toBe('Word#{=1}');
  view.dispatch({ selection: { anchor: 1, head: 3 } });
  insertSourceNumber(view, 1);
  expect(text(view)).toBe('W#{=1}d#{=1}');
});

it('has no typed offer for unmatched literals and explains when all live numbers are used', () => {
  const view = editor('Value 5.', '999');
  view.dispatch({ selection: { anchor: 3 } });
  expect(typedNumberOffer(view.state)).toBeNull();
  const complete = editor('Value 5.', '#{=1}');
  complete.dispatch({ selection: { anchor: 5 } });
  tabNumber(complete);
  expect(complete.state.field(numberField).message).toBe('All numbers used');
  expect(text(complete)).toBe('#{=1}');
});

it('converts unique typed values with formula variables in one undo and leaves equal choices literal', () => {
  const view = editor(
    'Damage ${5+#d} for 10 seconds. Gain 5 stacks, lose 5 stacks.\nenhanced (\nvar d = 2\n)',
    'Schaden 5 für 10 Sekunden.',
  );
  // 5 is shared by three slots; 10 has exactly one source identity.
  expect(convertTypedNumbers(view)).toBe(true);
  expect(text(view)).toBe('Schaden 5 für #{=2} Sekunden.');
  expect(undo(view)).toBe(true);
  expect(text(view)).toBe('Schaden 5 für 10 Sekunden.');
  const formula = editor('Damage ${5+#d}.\nenhanced (\nvar d = 2\n)', 'Schaden 5.');
  expect(convertTypedNumbers(formula)).toBe(true);
  expect(text(formula)).toContain('var d = #{=2}');
  expect(undo(formula)).toBe(true);
  expect(text(formula)).toBe('Schaden 5.');
});

it('inserts a median five-number translation in five keys, with no lookup', () => {
  const view = editor(
    'Deals 5 damage for 6 seconds. Hits 7 enemies up to 8 times within 9 meters.',
  );
  for (let i = 0; i < 5; i++) {
    expect(tabNumber(view)).toBe(true);
    if (i < 4) view.dispatch(view.state.replaceSelection(' '));
  }
  expect(text(view)).toBe('#{=1} #{=2} #{=3} #{=4} #{=5}');
  expect(orderedNumbers(view.state)).toEqual([]);
});

it('cycles both ways across long pauses, then undoes the whole cycle once', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const view = editor('Grants 5 stacks lasting 5 seconds. Maximum 10 stacks.', 'Wort');
  view.dispatch({ selection: { anchor: 4 } });
  tabNumber(view);
  vi.setSystemTime(Date.now() + 1500);
  tabNumber(view);
  expect(text(view)).toBe('Wort#{=2}');
  vi.setSystemTime(Date.now() + 1500);
  tabNumber(view, -1);
  expect(text(view)).toBe('Wort#{=1}');
  expect(undo(view)).toBe(true);
  expect(text(view)).toBe('Wort');
});

it('ends a cycle on typing or a caret move, and orders after the nearest token', () => {
  const view = editor('Values 10, 20, and 30.');
  insertNumber(view, 2);
  view.dispatch(view.state.replaceSelection(' '));
  expect(orderedNumbers(view.state)).toEqual([3, 1]);
  tabNumber(view);
  view.dispatch({ selection: { anchor: 0 } });
  expect(view.state.field(numberField).cycle).toBeNull();
  tabNumber(view);
  expect(text(view)).toBe('#{=1}#{=2} #{=3}');
});

it('brings formula declarations inside the enhanced block, and removes both when cycling', () => {
  const view = editor('Damage ${5+#d}.\nenhanced (\nvar d = 2\n)\nOther 9.');
  tabNumber(view);
  expect(text(view)).toBe('#{=1}\nenhanced (\nvar d = #{=2}\n)');
  tabNumber(view);
  expect(text(view)).toBe('#{=3}');
  undo(view);
  expect(text(view)).toBe('');
});

it('does not duplicate an existing scoped declaration and refuses formula interiors', () => {
  const view = editor(
    'Damage ${5+#d}.\nenhanced (\nvar d = 2\n)',
    '\nenhanced (\nvar d = #{=2}\n)',
  );
  insertNumber(view, 1);
  expect(text(view).match(/var d/g)).toHaveLength(1);
  const other = editor('Value 5.', '${2*3}');
  other.dispatch({ selection: { anchor: 3 } });
  tabNumber(other);
  expect(text(other)).toBe('${2*3}');
  expect(other.state.field(numberField).message).toBe("Numbers can't go here");
});

it('keeps raw clipboard text, renders translated decimals, and maps deletion and undo', () => {
  const view = editor('Lasts 4.5 seconds.', '#{=1}');
  expect(view.dom.querySelector('.clarity-number-token')?.textContent).toBe('4,5');
  expect(text(view)).toBe('#{=1}');
  view.dispatch({ changes: { from: 0, to: 5 } });
  expect(orderedNumbers(view.state)).toEqual([1]);
  undo(view);
  expect(orderedNumbers(view.state)).toEqual([]);
  expect(tokenizedEnglish(numberSource('Value 5.', undefined, 'de'))).toBe('Value #{=1}.');
});

it('converts a typed number, cycles equal values, and restores the literal with one undo', () => {
  const view = editor('Gain 5 stacks lasting 5 seconds.', 'Dauer 5');
  view.dispatch({ selection: { anchor: 7 } });
  expect(typedNumberOffer(view.state)?.ids).toEqual([1, 2]);
  tabNumber(view);
  expect(text(view)).toBe('Dauer #{=1}');
  tabNumber(view);
  expect(text(view)).toBe('Dauer #{=2}');
  undo(view);
  expect(text(view)).toBe('Dauer 5');
  expect(dismissNumberOffer(view)).toBe(true);
  expect(typedNumberOffer(view.state)).toBeNull();
  tabNumber(view);
  expect(text(view)).toBe('Dauer 5#{=1}');
});

it('deletes a token atomically with Backspace', () => {
  const view = editor('Value 5.', 'Wort #{=1}');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  deleteCharBackward(view);
  expect(text(view)).toBe('Wort ');
  undo(view);
  expect(text(view)).toBe('Wort #{=1}');
});

it('renders frozen retired values and unknown ids, while read-only commands cannot insert', () => {
  const source = numberSource('Damage 5.', { ids: [7], next: 8, retired: { 2: '4.5' } }, 'de');
  const view = new EditorView({
    state: EditorState.create({
      doc: '#{=7} #{=2} #{=99}',
      extensions: [
        numberHost.of({ source, lang: 'de' }),
        numberExtension(),
        EditorState.readOnly.of(true),
      ],
    }),
  });
  views.push(view);
  expect(view.dom.querySelector('[data-number-id="7"]')?.textContent).toBe('5');
  expect(view.dom.querySelector('[data-number-id="2"]')?.textContent).toBe('4,5');
  expect(view.dom.querySelector('[data-number-id="2"]')?.getAttribute('data-severity')).toBe(
    'warning',
  );
  expect(view.dom.querySelector('[data-number-id="99"]')?.textContent).toBe('?');
  expect(view.dom.querySelector('[data-number-id="99"]')?.getAttribute('data-severity')).toBe(
    'error',
  );
  expect(insertNumber(view, 7)).toBe(false);
  expect(text(view)).toBe('#{=7} #{=2} #{=99}');
});

it('offers both the English and local decimal spelling without automatic conversion', () => {
  for (const literal of ['4.5', '4,5']) {
    const view = editor('Lasts 4.5 seconds.', literal);
    view.dispatch({ selection: { anchor: literal.length } });
    expect(text(view)).toBe(literal);
    expect(typedNumberOffer(view.state)?.ids).toEqual([1]);
    tabNumber(view);
    expect(text(view)).toBe('#{=1}');
  }
});

it('refuses unfinished maths, reference targets, variable names, and import lines', () => {
  for (const [doc, head] of [
    ['${2*', 4],
    ['<link Label [target', 19],
    ['#{d}', 2],
    ['import main from 12', 10],
  ] as const) {
    const view = editor('Value 5.', doc);
    view.dispatch({ selection: { anchor: Math.min(head, view.state.doc.length) } });
    tabNumber(view);
    expect(text(view)).toBe(doc);
    expect(view.state.field(numberField).message).toBe("Numbers can't go here");
  }
});

it('keeps command reads bounded on an unbroken long line', () => {
  const view = editor('Value 5.', 'word '.repeat(2000));
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const original = view.state.doc.sliceString.bind(view.state.doc);
  let largest = 0;
  const spy = vi.spyOn(view.state.doc, 'sliceString').mockImplementation((from, to, separator) => {
    largest = Math.max(largest, (to ?? view.state.doc.length) - (from ?? 0));
    return original(from, to, separator);
  });
  tabNumber(view);
  spy.mockRestore();
  expect(largest).toBeLessThanOrEqual(4);
  expect(text(view).endsWith('#{=1}')).toBe(true);
});
