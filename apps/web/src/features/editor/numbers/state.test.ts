// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { deleteCharBackward, history, undo } from '@codemirror/commands';
import { numberSource, tokenizedEnglish } from './model';
import {
  dismissNumberOffer,
  insertNumber,
  numberExtension,
  numberField,
  numberHost,
  orderedNumbers,
  tabNumber,
  typedNumberOffer,
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
  expect(text(view)).toBe('#{=2}');
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
