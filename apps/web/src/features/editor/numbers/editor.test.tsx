// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClarityEditor } from '../ClarityEditor';
import { numberField, insertNumber } from './state';
import { startFromEnglish } from './NumberTools';
import { missingNumberVariables } from './diagnostics';
import { openSuggest, suggestState } from '../suggest/state';
import { setStops } from '../suggest/stops';
import { Transaction } from '@codemirror/state';
import { chipState, markChipShown } from '../markupRow/chips';
import { useSettingsStore } from '../../../stores/settings';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getStyle(element));
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
    left: 10,
    right: 10,
    top: 10,
    bottom: 20,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useSettingsStore.setState(state=>({settings:{...state.settings,suggestAccept:'enter'}}));
});
function mount(sourceText = 'Gain 5 stacks lasting 5 seconds.', value = '') {
  const changes: string[] = [];
  act(() =>
    root.render(
      <ClarityEditor
        lang="de"
        value={value}
        sourceText={sourceText}
        globals={{ variables: '', titles: '' }}
        onChange={(value) => changes.push(value)}
        tooltipHash={7}
        markupRow
      />,
    ),
  );
  return {
    view: EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!,
    changes,
  };
}
const key = (view: EditorView, name: string) =>
  act(() =>
    runScopeHandlers(
      view,
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      'editor',
    ),
  );

it('shows atomic values, the count, and equal-value context through the real Tab keymap', () => {
  const { view, changes } = mount();
  key(view, 'Tab');
  expect(changes.at(-1)).toBe('#{=1}');
  expect(host.querySelector('[data-status-numbers]')?.textContent).toContain('1/2');
  expect(document.querySelector('[data-number-readout]')?.textContent).toContain('stacks');
  key(view, 'Tab');
  expect(changes.at(-1)).toBe('#{=2}');
  expect(document.querySelector('[data-number-readout]')?.textContent).toContain('seconds');
  expect(host.querySelector('.clarity-number-token')?.textContent).toBe('5');
});

it('leaves Enter as a newline, dismisses the typed offer with Escape, and keeps Tab available', () => {
  const { view } = mount(undefined, '5');
  act(() => view.dispatch({ selection: { anchor: 1 } }));
  expect(document.querySelector('[data-number-readout]')?.textContent).toContain('Tab');
  key(view, 'Enter');
  expect(view.state.doc.toString()).toBe('5\n');
  act(() => view.dispatch({ selection: { anchor: 1 } }));
  key(view, 'Escape');
  expect(document.querySelector('[data-number-readout]')).toBeNull();
  key(view, 'Tab');
  expect(view.state.doc.toString()).toBe('5#{=1}\n');
});

it('starts empty translations from English, guards existing work, and inserts formulas without W7', () => {
  const english = 'Damage ${5+#d}.\nenhanced (\nvar d = 2\n)';
  const { view } = mount(english);
  key(view, 'Tab');
  expect(missingNumberVariables(view.state.doc.toString(), english, undefined, 'de')).toEqual([]);
  expect(view.state.field(numberField).cycle).not.toBeNull();
  expect(startFromEnglish(view)).toBe(false);
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length } }));
  act(() => expect(startFromEnglish(view)).toBe(true));
  expect(view.state.doc.toString()).toBe('Damage #{=1}.\nenhanced (\nvar d = #{=2}\n)');
});

it('leads the chip row with the next unused number and returns panel Escape to the caret', async () => {
  const { view } = mount('Values 10, 20, and 30.');
  act(() => insertNumber(view, 2));
  expect(
    [...host.querySelectorAll('[data-number-chip]')].map((el) =>
      el.getAttribute('data-number-chip'),
    ),
  ).toEqual(['3', '1']);
  await act(async () => (host.querySelector('[data-status-numbers]') as HTMLButtonElement).click());
  const panel = document.getElementById('editor-panel-numbers')!;
  expect(panel.querySelector('li')?.textContent).toContain('To do');
  await act(async () =>
    panel
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.getElementById('editor-panel-numbers')).toBeNull();
  expect(view.hasFocus).toBe(true);
});

it('keeps suggestions, snippets, and Tab-configured markup chips ahead of number Tab', () => {
  const { view } = mount('Value 5.');
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: '<so' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    }),
  );
  act(() => openSuggest(view));
  expect(suggestState(view.state)).not.toBeNull();
  key(view, 'Tab');
  expect(view.state.doc.toString()).toBe('<solar/>');
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'AB' },
      selection: { anchor: 0, head: 1 },
      effects: setStops.of([
        { from: 0, to: 1 },
        { from: 1, to: 2 },
      ]),
    }),
  );
  key(view, 'Tab');
  expect(view.state.doc.toString()).toBe('AB');
  expect(view.state.selection.main.from).toBe(1);
  expect(view.state.selection.main.to).toBe(2);
  key(view, 'Escape');
  act(() => useSettingsStore.setState(state=>({settings:{...state.settings,suggestAccept:'tab'}})));
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'pve' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    }),
  );
  expect(chipState(view.state)).not.toBeNull();
  // jsdom has no viewport geometry; this is the renderer's visible-chip signal.
  markChipShown(view, true);
  key(view, 'Tab');
  expect(view.state.doc.toString()).toBe('<pve value />');
});
