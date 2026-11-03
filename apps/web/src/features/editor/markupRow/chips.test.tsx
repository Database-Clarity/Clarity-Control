// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from '../ClarityEditor';
import { useSettingsStore } from '../../../stores/settings';
import { chipState, type Chip } from './chips';
import { placeChip } from './SuggestChip';

const globals: MarkupGlobals = { variables: 'var damage = 25', titles: '' };

let host: HTMLDivElement;
let root: Root;
const line = { left: 40, right: 41, top: 100, bottom: 116 };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue(line);
  // The editor spans a 800 x 600 window; the chip itself is a 280 x 26 box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const chip = this.hasAttribute('data-suggest-chip');
    return {
      left: 0,
      right: chip ? 280 : 800,
      top: 0,
      bottom: chip ? 26 : 600,
      width: chip ? 280 : 800,
      height: chip ? 26 : 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
  useSettingsStore.getState().updateDevice({ suggestAccept: 'enter' });
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

function mount(doc: string, extra: Partial<Parameters<typeof ClarityEditor>[0]> = {}) {
  act(() =>
    root.render(
      <ClarityEditor value={doc} lang="en" globals={globals} onChange={() => {}} {...extra} />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  return view;
}
const chipNode = () => document.body.querySelector<HTMLElement>('[data-suggest-chip]');
const type = (view: EditorView, text: string) =>
  act(() => {
    for (const character of text) {
      const at = view.state.selection.main.head;
      view.dispatch({
        changes: { from: at, insert: character },
        selection: { anchor: at + 1 },
        userEvent: 'input.type',
      });
    }
  });
function press(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  let handled = false;
  act(() => {
    handled = runScopeHandlers(view, event, 'editor');
  });
  return handled;
}

describe('suggestion chips for a typed tag word', () => {
  it('offers the icon for “Kinetic” and inserts it before the word on Enter, keeping the caret after it', () => {
    const view = mount('Deals ');
    type(view, 'Kinetic');
    expect(chipNode()).not.toBeNull();
    expect(chipNode()!.textContent).toContain('<kinetic/>');
    expect(chipNode()!.parentElement).toBe(document.body); // outside the text, never in its flow
    // Offering it changed nothing.
    expect(view.state.doc.toString()).toBe('Deals Kinetic');
    expect(press(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe('Deals <kinetic/>Kinetic');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(chipNode()).toBeNull();
  });

  it('Enter only accepts while the chip is showing; otherwise it is a line break', () => {
    const view = mount('Deals ');
    type(view, 'Kinetic');
    type(view, ' ');
    expect(chipNode()).toBeNull();
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Deals Kinetic \n');
  });

  it('Esc dismisses it and the same offer does not come back until the text changes', () => {
    const view = mount('Deals ');
    type(view, 'Solar');
    expect(chipNode()).not.toBeNull();
    expect(press(view, 'Escape')).toBe(true);
    expect(chipNode()).toBeNull();
    expect(view.state.doc.toString()).toBe('Deals Solar');
    // A selection-only transaction at the same place does not resurrect it.
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    expect(chipNode()).toBeNull();
    // Esc with no chip is left to whoever else wants it.
    expect(press(view, 'Escape')).toBe(false);
  });

  it('Shift+Enter makes a line break and keeps the chip decision with the author', () => {
    const view = mount('Deals ');
    type(view, 'Arc');
    expect(chipNode()).not.toBeNull();
    expect(press(view, 'Enter', { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toMatch(/^Deals Arc\n/);
    expect(chipNode()).toBeNull();
  });

  it('other keys carry on typing and re-evaluate the chip', () => {
    const view = mount('Deals ');
    type(view, 'Arc');
    expect(chipNode()).not.toBeNull();
    type(view, 'h');
    expect(chipNode()).toBeNull();
  });

  it('device setting Tab: Tab accepts and Enter is always a line break', () => {
    act(() => useSettingsStore.getState().updateDevice({ suggestAccept: 'tab' }));
    const view = mount('Deals ');
    type(view, 'Void');
    expect(chipNode()!.textContent).toContain('Tab');
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('Deals <void/>Void');
  });

  it('with the Tab setting, Enter never takes the chip', () => {
    act(() => useSettingsStore.getState().updateDevice({ suggestAccept: 'tab' }));
    const view = mount('Deals ');
    type(view, 'Void');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Deals Void\n');
  });

  it('offers the lower-case tags pve and pvp, not prose such as “PvE”', () => {
    const view = mount('Deals ');
    type(view, 'PvE');
    expect(chipNode()).toBeNull();
    type(view, ' pve');
    expect(chipNode()).not.toBeNull();
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Deals PvE <pve value />');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'value',
    );
  });

  it('is not offered mid-word, inside markup, when read-only, or while the menu is open', () => {
    const inWord = mount('Deals Kineticx');
    act(() => inWord.dispatch({ selection: { anchor: 13 } }));
    type(inWord, 'z');
    expect(chipNode()).toBeNull();
    const inTag = mount('<bold ');
    type(inTag, 'Solar');
    expect(chipNode()).toBeNull();
    const readOnly = mount('Deals ', { readOnly: true });
    type(readOnly, 'Solar');
    expect(chipNode()).toBeNull();
    const menu = mount('Deals ');
    type(menu, '<');
    expect(chipNode()).toBeNull();
  });
});

describe('a chip that cannot be seen', () => {
  it('does not take Enter: the key makes a line break instead', () => {
    const view = mount('Deals ');
    type(view, 'Void');
    expect(chipNode()).not.toBeNull();
    // The text scrolls out of the editor, so the chip hides itself.
    vi.mocked(EditorView.prototype.coordsAtPos).mockReturnValue({
      left: 40,
      right: 41,
      top: 900,
      bottom: 916,
    });
    act(() => view.scrollDOM.dispatchEvent(new Event('scroll')));
    expect(chipNode()!.style.visibility).toBe('hidden');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Deals Void\n');
  });
});

describe('suggestion chips for a selection', () => {
  it('offers the PvE/PvP pair for “6.5 [5]” and Enter applies it to the selection', () => {
    const view = mount('Gains 6.5 [5] speed');
    act(() => view.dispatch({ selection: { anchor: 6, head: 13 } }));
    expect(chipNode()).not.toBeNull();
    expect(chipNode()!.textContent).toContain('<pve 6.5 /> <pvp [5] />');
    expect(view.state.doc.toString()).toBe('Gains 6.5 [5] speed'); // only offered
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('Gains <pve 6.5 /> <pvp [5] /> speed');
  });

  it('is not offered for a selection no transform understands, or one that already holds markup', () => {
    const view = mount('Hello <pve 5 /> there');
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    expect(chipNode()).toBeNull();
    act(() => view.dispatch({ selection: { anchor: 6, head: 14 } }));
    expect(chipNode()).toBeNull();
  });

  it('goes away when the selection becomes a caret, and Esc dismisses it', () => {
    const view = mount('Gains 6.5 [5] speed');
    act(() => view.dispatch({ selection: { anchor: 6, head: 13 } }));
    expect(chipNode()).not.toBeNull();
    press(view, 'Escape');
    expect(chipNode()).toBeNull();
    act(() => view.dispatch({ selection: { anchor: 6, head: 13 } }));
    expect(chipNode()).toBeNull();
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    expect(chipState(view.state)).toBeNull();
  });
});

describe('where the chip floats', () => {
  const chip = (from: number, to: number): Chip =>
    ({
      covers: { from, to },
      key: 'k',
      markup: '',
      text: '',
      typed: false,
      item: {},
    }) as unknown as Chip;

  it('sits under the last line of the text it is about, never on a selected character', () => {
    const view = mount('Gains 6.5 [5] speed');
    const spot = placeChip(view, chip(6, 13), { width: 280, height: 26 });
    // Every selected character is on a line that ends at 116; the chip starts below it.
    expect(spot!.top).toBeGreaterThanOrEqual(line.bottom);
  });

  it('flips above the first line when there is no room below, and still clears the text', () => {
    const view = mount('Gains 6.5 [5] speed');
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(130);
    const spot = placeChip(view, chip(6, 13), { width: 280, height: 26 });
    expect(spot).not.toBeNull();
    expect(spot!.top + 26).toBeLessThanOrEqual(line.top);
  });

  it('hides when the text is scrolled out of the editor', () => {
    const view = mount('Gains 6.5 [5] speed');
    vi.mocked(EditorView.prototype.coordsAtPos).mockReturnValue({
      left: 40,
      right: 41,
      top: 700,
      bottom: 716,
    });
    expect(placeChip(view, chip(6, 13), { width: 280, height: 26 })).toBeNull();
  });
});
