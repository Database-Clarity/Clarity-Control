// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from '../ClarityEditor';
import { suggestState } from './state';

const globals: MarkupGlobals = {
  variables: 'var e = 🡅\nvar damage = 25',
  titles: 'title G_refill (\nRefills the magazine.\n)',
};

let host: HTMLDivElement;
let root: Root;
const changes: string[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no layout: the caret is "at" a fixed spot on screen.
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
    left: 40,
    right: 41,
    top: 100,
    bottom: 116,
  });
  // ...and the editor's scroller spans the screen, so that caret is inside it.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 800,
    top: 0,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  changes.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const usage = {
  size: 100,
  count: (pattern: RegExp) => (pattern.source.includes('pvp') ? 485 : 7),
};

function mount(doc: string, extra: Partial<Parameters<typeof ClarityEditor>[0]> = {}) {
  act(() =>
    root.render(
      <ClarityEditor
        value={doc}
        lang="en"
        globals={globals}
        usage={usage}
        onChange={(text) => changes.push(text)}
        {...extra}
      />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  return view;
}
const menu = () => document.body.querySelector<HTMLElement>('[data-suggest-menu]');
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role=option]')];
const selected = () => options().find((option) => option.getAttribute('aria-selected') === 'true');
function press(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  let handled = false;
  act(() => {
    handled = runScopeHandlers(view, event, 'editor');
  });
  return handled;
}
const type = (view: EditorView, text: string) =>
  act(() => {
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: 'input.type',
    });
  });

describe('the suggestion menu', () => {
  it('opens on a typed < and browsing it never touches the document', () => {
    const view = mount('Gains ');
    type(view, '<');
    expect(menu()).not.toBeNull();
    expect(menu()!.parentElement).toBe(document.body); // outside the editor, never in the text flow
    const before = view.state.doc.toString();
    const first = selected()!.textContent;
    press(view, 'ArrowDown');
    press(view, 'ArrowDown');
    expect(selected()!.textContent).not.toBe(first);
    act(() => {
      options()[3]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(selected()).toBe(options()[3]);
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.toString()).toBe('Gains <');
    expect(changes).toEqual(['Gains <']); // only the typed character ever reached the page
  });

  it('inserts only on Enter (or Tab, or a click) and Esc closes without inserting', () => {
    const view = mount('Gains ');
    type(view, '<');
    press(view, 'Escape');
    expect(menu()).toBeNull();
    expect(view.state.doc.toString()).toBe('Gains <');

    // Esc dismisses until the next trigger: more typing does not bring it back.
    type(view, 'pv');
    expect(menu()).toBeNull();
    expect(view.state.doc.toString()).toBe('Gains <pv');
  });

  it('Enter inserts the highlighted option in place of the typed word and selects its first stop', () => {
    const view = mount('Gains ');
    type(view, '<');
    type(view, 'pve');
    expect(selected()!.textContent).toContain('<pve />');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Gains <pve value />');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'value',
    );
    expect(menu()).toBeNull();
  });

  it('Enter keeps its usual job when the option would only re-type the finished word', () => {
    const view = mount('x' + String.fromCharCode(10));
    type(view, '#');
    type(view, 'damage');
    expect(selected()!.textContent).toContain('#damage');
    press(view, 'Enter'); // the editor's own newline, not a second #damage
    expect(menu()).toBeNull();
    expect(view.state.doc.toString()).toBe(
      'x' + String.fromCharCode(10) + '#damage' + String.fromCharCode(10),
    );
  });

  it('Tab walks the stops of a pair snippet', () => {
    const view = mount('');
    act(() => {
      press(view, ' ', { ctrlKey: true, keyCode: 32 });
    });
    expect(menu()).not.toBeNull();
    const index = options().findIndex((option) => option.textContent === 'PvE and PvP values');
    expect(index).toBeGreaterThan(-1);
    act(() => options()[index]!.click());
    expect(view.state.doc.toString()).toBe('<pve value /> <pvp [value] />');
    const picked = () =>
      view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    expect(picked()).toBe('value');
    expect(view.state.selection.main.from).toBe('<pve '.length);
    press(view, 'Tab');
    expect(view.state.selection.main.from).toBe('<pve value /> <pvp ['.length);
    expect(picked()).toBe('value');
    press(view, 'Tab'); // past the last stop: the caret ends after it
    expect(view.state.selection.main.empty).toBe(true);
  });

  it('transforms a selection on Ctrl+Space, with Transforms first', () => {
    const view = mount('Reload 6.5 [5] speed');
    act(() => view.dispatch({ selection: { anchor: 7, head: 14 } }));
    press(view, ' ', { ctrlKey: true, keyCode: 32 });
    const first = options()[0]!;
    expect(first.closest('[role=listbox]')!.querySelector('[role=presentation]')!.textContent).toBe(
      'Transforms',
    );
    expect(first.textContent).toContain('X [Y] to PvE and PvP');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Reload <pve 6.5 /> <pvp [5] /> speed');
  });

  it('shows the rendered line and the corpus usage count in the detail pane only', () => {
    const view = mount('Gains ');
    type(view, '<');
    type(view, 'pvp');
    const detail = document.body.querySelector<HTMLElement>('[data-suggest-detail]')!;
    expect(detail.textContent).toContain('<pvp [value] />');
    expect(detail.querySelector('[data-suggest-usage]')!.textContent).toBe('Used in 485 tooltips');
    expect(detail.textContent).toContain('Gains'); // the line, rendered, with the option applied
    expect(document.body.querySelector('[role=listbox]')!.textContent).not.toMatch(/Used in|485/);
  });

  it('shows both variant results for the inline base/enhanced snippet without editing', () => {
    const view = mount('Gains ');
    press(view, ' ', { ctrlKey: true, keyCode: 32 });
    const index = options().findIndex((option) => option.textContent === 'Base and enhanced text');
    expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < index; i++) press(view, 'ArrowDown');
    const preview = document.body.querySelector('[data-suggest-detail] [aria-label="Preview"]')!;
    expect(preview.textContent).toMatch(/Base.*Gains base.*Enhanced.*Gains enhanced/s);
    expect(changes).toEqual([]);
  });

  it('inserts native pairs with Enter and walks their two editable arms with Tab', () => {
    const view = mount('Gains ');
    press(view, ' ', { ctrlKey: true, keyCode: 32 });
    const index = options().findIndex((option) => option.textContent === 'Base and enhanced text');
    for (let i = 0; i < index; i++) press(view, 'ArrowDown');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Gains {{base}{enhanced}}');
    const picked = () =>
      view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    expect(picked()).toBe('base');
    act(() => view.dispatch(view.state.replaceSelection('10')));
    press(view, 'Tab');
    expect(picked()).toBe('enhanced');
    act(() => view.dispatch(view.state.replaceSelection('20')));
    press(view, 'Tab');
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.doc.toString()).toBe('Gains {{10}{20}}');
    expect(changes.at(-1)).toBe('Gains {{10}{20}}');
  });

  it('inserting an enhanced section fills the enhanced arrow line', () => {
    const view = mount('Base text.\n\nenh');
    press(view, ' ', { ctrlKey: true, keyCode: 32 });
    const index = options().findIndex((option) => option.textContent === 'Enhanced section');
    expect(index).toBeGreaterThan(-1);
    act(() => options()[index]!.click());
    expect(view.state.doc.toString()).toBe(
      'Base text.\n\nenhanced (\nvar d = amount\n#e What the enhanced version changes.\n)',
    );
  });

  it('refuses to insert inside a protected line, says why, and leaves the text alone', () => {
    const view = mount('Gains #damage ');
    type(view, '<');
    type(view, 'pve');
    expect(menu()).not.toBeNull();
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Gains #damage <pve');
    expect(menu()!.querySelector('[role=alert]')!.textContent).toMatch(/Cannot insert|variable/);
  });

  it('does not open in a read-only editor or while the editor is blurred', () => {
    const view = mount('Gains ', { readOnly: true });
    type(view, '<');
    expect(menu()).toBeNull();
    expect(suggestState(view.state)).toBeNull();
  });

  it('no longer offers the retired line styles', () => {
    const view = mount('Hello ');
    press(view, ' ', { ctrlKey: true, keyCode: 32 });
    const labels = options().map((option) => option.textContent!);
    expect(labels.some((label) => /<center\/>|<background\/>|<breakSpaces\/>/.test(label))).toBe(
      false,
    );
  });

  it('a menu opened on a bare word closes once the caret leaves that word', () => {
    const view = mount('Gains ');
    press(view, ' ', { ctrlKey: true, keyCode: 32 });
    type(view, 'fo');
    expect(menu()).not.toBeNull();
    type(view, 'o ');
    expect(menu()).toBeNull();
    type(view, 'x');
    press(view, 'Enter'); // a plain newline, not a snippet
    expect(view.state.doc.toString()).toBe('Gains foo x' + String.fromCharCode(10));
  });

  it('closes when the caret leaves the word', () => {
    const view = mount('Gains ');
    type(view, '<');
    expect(menu()).not.toBeNull();
    type(view, ' ');
    expect(menu()).toBeNull();
  });
});
