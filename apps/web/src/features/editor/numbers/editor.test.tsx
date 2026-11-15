// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClarityEditor } from '../ClarityEditor';
import { numberField } from './state';
import { startFromEnglish } from './NumberTools';
import { missingNumberVariables } from './diagnostics';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
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
