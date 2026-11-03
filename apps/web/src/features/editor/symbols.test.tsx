// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { useSettingsStore } from '../../stores/settings';
import { findSymbols } from './symbols';

const globals: MarkupGlobals = { variables: '', titles: '' };
const doc = 'Deal <arc/> damage <yellow 5 <solar/> /> and <pve 3 /> done.\n<void/>';

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

function mount(value = doc, extra: Partial<Parameters<typeof ClarityEditor>[0]> = {}) {
  const changes: string[] = [];
  act(() =>
    root.render(
      <ClarityEditor
        value={value}
        lang="en"
        globals={globals}
        onChange={(text) => changes.push(text)}
        {...extra}
      />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  return { view, changes };
}
const key = (view: EditorView, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  return runScopeHandlers(view, event, 'editor');
};
const symbols = () => [...host.querySelectorAll<HTMLElement>('.cm-symbol')];

describe('findSymbols', () => {
  it('finds icon tags and pairs colour tags per line, leaving the rest raw', () => {
    const found = findSymbols(doc).map((s) => [s.kind, s.name, doc.slice(s.from, s.to)]);
    expect(found).toEqual([
      ['icon', 'arc', '<arc/>'],
      ['open', 'yellow', '<yellow '],
      ['icon', 'solar', '<solar/>'],
      ['close', 'yellow', ' />'],
      ['open', 'pve', '<pve '],
      ['close', 'pve', ' />'],
      ['icon', 'void', '<void/>'],
    ]);
    expect(findSymbols('a /> b <link x /> <center y />')).toEqual([]);
    expect(findSymbols('<unknown/> <notatag >')).toEqual([]);
  });
});

describe('symbol widgets', () => {
  it('draw every symbol in one fixed-width box and never change the document', () => {
    const { view, changes } = mount();
    expect(view.state.doc.toString()).toBe(doc);
    expect(changes).toEqual([]);
    expect(symbols()).toHaveLength(7);
    expect(host.querySelector('.cm-content')!.textContent).not.toContain('<arc/>');
    expect(
      symbols()
        .filter((s) => s.dataset.symbol !== undefined)
        .map((s) => s.dataset.symbol),
    ).toEqual(['arc', 'yellow', 'solar', 'yellow', 'pve', 'pve', 'void']);
    // Copying selects the raw text.
    expect(view.state.sliceDoc(0, view.state.doc.length)).toBe(doc);
  });

  it('are atomic: Backspace removes the whole tag and only that', () => {
    const { view } = mount();
    const end = doc.indexOf('<arc/>') + '<arc/>'.length;
    act(() => view.dispatch({ selection: { anchor: end } }));
    act(() => {
      key(view, { key: 'Backspace' });
    });
    expect(view.state.doc.toString()).toBe(doc.replace('<arc/>', ''));
  });

  it('raw toggle (Ctrl+Shift+.) shows the markup and survives a document switch', () => {
    const { view } = mount();
    act(() => {
      key(view, { key: '.', code: 'Period', ctrlKey: true, shiftKey: true });
    });
    expect(symbols()).toHaveLength(0);
    expect(host.querySelector('.cm-content')!.textContent).toContain('<arc/>');
    expect(view.state.doc.toString()).toBe(doc);
    act(() =>
      root.render(
        <ClarityEditor value="<arc/> x" lang="en" globals={globals} onChange={() => {}} />,
      ),
    );
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(0);
    act(() => {
      key(view, { key: '.', code: 'Period', ctrlKey: true, shiftKey: true });
    });
    expect(host.querySelectorAll('.cm-symbol')).toHaveLength(1);
  });

  it('popover mode: a selected symbol shows its markup, Enter edits it, Esc cancels', () => {
    const { view } = mount();
    const from = doc.indexOf('<arc/>');
    act(() => view.dispatch({ selection: { anchor: from, head: from + 6 } }));
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<arc/>');
    act(() => {
      key(view, { key: 'Enter' });
    });
    const input = host.querySelector<HTMLInputElement>('.cm-symbol-input')!;
    expect(input.value).toBe('<arc/>');
    input.value = '<void/>';
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(view.state.doc.toString()).toBe(doc.replace('<arc/>', '<void/>'));
    expect(host.querySelector('.cm-symbol-input')).toBeNull();
  });

  it('hover shows the popover without touching the document', () => {
    const { view } = mount();
    const widget = symbols()[0];
    act(() => {
      widget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(view.state.doc.toString()).toBe(doc);
    expect(host.querySelector('.cm-symbol-popover code')?.textContent).toBe('<arc/>');
    act(() => {
      widget.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(host.querySelector('.cm-symbol-popover')).toBeNull();
  });

  it('caret mode shows the raw markup only where the caret is', () => {
    act(() => useSettingsStore.getState().updateDevice({ symbolReveal: 'caret' }));
    const { view } = mount();
    act(() => view.dispatch({ selection: { anchor: doc.indexOf('<arc/>') + 2 } }));
    expect(host.querySelector('.cm-content')!.textContent).toContain('<arc/>');
    expect(host.querySelector('.cm-content')!.textContent).not.toContain('<solar/>');
    expect(host.querySelector('.cm-symbol-popover')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('are absent when the editor shows stored forms', () => {
    mount(doc, { symbols: false, readOnly: true });
    expect(symbols()).toHaveLength(0);
  });
});
