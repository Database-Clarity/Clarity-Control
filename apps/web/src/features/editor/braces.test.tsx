// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { ClarityEditor } from './ClarityEditor';
import { useSettingsStore } from '../../stores/settings';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { markupEntries, variableInsert } from './markupRow/entries';
import { offeredHere } from './markupScope';
import { referenceInLine } from './references';
import { findSymbols } from './symbols';
import { clarityLanguage } from './language';
import { helpIdAt } from './help/reference';

const highlighter = tagHighlighter([
  { tag: tags.variableName, class: 'variable' },
  { tag: tags.number, class: 'number' },
  { tag: tags.tagName, class: 'tag' },
]);
function highlights(text: string) {
  const ranges: { text: string; kind: string }[] = [];
  highlightTree(clarityLanguage.parser.parse(text), highlighter, (from, to, kind) => {
    ranges.push({ text: text.slice(from, to), kind });
  });
  return ranges;
}

describe('enhanced arrow scope', () => {
  it.each([true, false])('offers the arrow and its snippets only with base/enhanced (%s)', (allowed) => {
    const globals = { variables: 'var e = 🡅', titles: '', allowBaseEnhanced: allowed };
    const ids = markupEntries(globals).map((entry) => entry.id);
    for (const id of ['base-enhanced-pair', 'enhanced-arrow', 'enhanced-formula', 'enhanced-block'])
      expect(ids.includes(id)).toBe(allowed);
    expect(offeredHere('enhanced-arrow', globals)).toBe(allowed);
    expect(offeredHere('pve', globals)).toBe(true);
  });
  it('writes the symbol, not #e', () => {
    const entries = markupEntries({ variables: '', titles: '', allowBaseEnhanced: true });
    expect(entries.find((entry) => entry.id === 'enhanced-arrow')?.markup).toBe('<enhanced/>');
    expect(entries.find((entry) => entry.id === 'enhanced-formula')?.markup).toBe(
      '<enhanced/>${base+#{d}}',
    );
  });
});

describe('delimited variables in the editor', () => {
  it('inserts braces only when a letter or digit follows', () => {
    expect(variableInsert('d', 'x')).toBe('#{d}');
    expect(variableInsert('d', '5')).toBe('#{d}');
    expect(variableInsert('d', ' ')).toBe('#d');
    expect(variableInsert('d', '')).toBe('#d');
    expect(variableInsert('d', '%')).toBe('#d');
  });
  it('hovers and opens #{name} like #name', () => {
    expect(referenceInLine('Deals #{dmg}x', 8)).toEqual({
      kind: 'variable',
      name: 'dmg',
      braced: true,
      from: 6,
      to: 12,
    });
    expect(referenceInLine('Deals #dmgx', 8)).toEqual({
      kind: 'variable',
      name: 'dmgx',
      from: 6,
      to: 11,
    });
  });
  it('highlights #{name}, also inside math', () => {
    expect(highlights('A #{d}x and ${1+#{d}} and ${#{d}*2}')).toEqual([
      { text: '#{d}', kind: 'variable' },
      { text: '${', kind: 'tag' },
      { text: '1', kind: 'number' },
      { text: '+#{d}', kind: 'variable' },
      { text: '}', kind: 'tag' },
      { text: '${', kind: 'tag' },
      // The first operand takes the base colour, as `${#d*2}` does.
      { text: '#{d}', kind: 'number' },
      { text: '*2', kind: 'variable' },
      { text: '}', kind: 'tag' },
    ]);
  });
  it('help finds the braced variable, the symbol, and its formula', () => {
    const at = (doc: string, pos: number) => helpIdAt(EditorState.create({ doc }), pos);
    expect(at('Deals #{d}x', 7)).toBe('var-braces');
    expect(at('Deals #d more', 7)).toBe('decl-var');
    expect(at('<enhanced/> Faster', 3)).toBe('enhanced-arrow');
    expect(at('Lasts <enhanced/>${7+#{d}} s', 20)).toBe('enhanced-formula');
    expect(at('Lasts ${7+#{d}} s', 10)).toBe('math');
  });
});

describe('the arrow symbol', () => {
  it('draws <enhanced/> and the legacy #e as the same arrow', () => {
    expect(findSymbols('<enhanced/> a #e b <arc/> <enhanced /> <bold/>')).toEqual([
      { from: 0, to: 11, kind: 'icon', name: 'enhanced-arrow' },
      { from: 14, to: 16, kind: 'icon', name: 'enhanced-arrow' },
      { from: 19, to: 25, kind: 'icon', name: 'arc' },
    ]);
  });
});

describe('one-click fixes', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSettingsStore.getState().updateDevice({ symbolReveal: 'popover' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const mount = (value: string) => {
    const changes: string[] = [];
    act(() =>
      root.render(
        <ClarityEditor
          value={value}
          lang="en"
          globals={{ variables: 'var e = 🡅', titles: '' }}
          onChange={(text) => changes.push(text)}
        />,
      ),
    );
    return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  };
  const button = (selector: string, label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(`${selector} button`)].find(
      (item) => item.textContent === label,
    );

  it('the legacy #e offers the symbol; the symbol itself has no fix', () => {
    const view = mount('Up #e and <enhanced/> x');
    act(() => view.dispatch({ selection: { anchor: 3, head: 5 } }));
    expect(document.querySelector('.cm-symbol-legacy')?.textContent).toBe('Old spelling');
    act(() => button('.cm-symbol-popover', 'Use <enhanced/>')!.click());
    expect(view.state.doc.toString()).toBe('Up <enhanced/> and <enhanced/> x');
    act(() => view.dispatch({ selection: { anchor: 19, head: 30 } }));
    expect(document.querySelector('.cm-symbol-popover code')?.textContent).toBe('<enhanced/>');
    expect(document.querySelector('.cm-symbol-legacy')).toBeNull();
    expect(button('.cm-symbol-popover', 'Use <enhanced/>')).toBeUndefined();
  });

  it('a merged variable offers the delimited form in its popover', () => {
    const view = mount('var d = 5\nDeals #dx damage.');
    act(() => view.dispatch({ selection: { anchor: 18 } }));
    act(() => {
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'F12', bubbles: true }), 'editor');
    });
    expect(document.querySelector('.clarity-reference-popover')?.textContent).toContain(
      'Variable #d merges with the text after it.',
    );
    act(() => button('.clarity-reference-popover', 'Write #{d}x')!.click());
    expect(view.state.doc.toString()).toBe('var d = 5\nDeals #{d}x damage.');
  });
});
