// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClarityEditor } from './ClarityEditor';
import { readSearchMemory, resetSearchMemory } from './searchMemory';

const globals = { variables: '', titles: '' };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetSearchMemory();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetSearchMemory();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(value: string, tooltipHash?: number, definitions = globals) {
  act(() =>
    root.render(
      <ClarityEditor
        value={value}
        lang="en"
        tooltipHash={tooltipHash}
        globals={definitions}
        onChange={() => {}}
      />,
    ),
  );
  return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
}

describe('find and replace persistence', () => {
  it('uses fresh import diagnostics when typing an import after unrelated snapshot edits', () => {
    const first = { ...globals, imports: { 42: '#missing' } };
    const next = { ...globals, imports: { 42: 'resolved' } };
    const view = render('plain', 10, first);
    render('plain', 10, next);
    act(() => view.dispatch({ changes: { from: 0, to: 5, insert: 'import main from 42' } }));
    render('import main from 42', 10, next);
    expect(view.dom.querySelector('.clarity-validation-warning')).toBeNull();
  });

  it('updates imported title diagnostics even while the document itself has no import', () => {
    const titles = 'title Detail (\nimport main from 42\n)';
    const first = { variables: '', titles, imports: { 42: '#missing' } };
    const next = { variables: '', titles, imports: { 42: 'resolved' } };
    const view = render('<title Label [Detail] />', 10, first);
    expect(view.dom.querySelector('.clarity-validation-warning')).not.toBeNull();
    render('<title Label [Detail] />', 10, next);
    expect(view.dom.querySelector('.clarity-validation-warning')).toBeNull();
  });
  it('reuses the view but resets undo and selection when another tooltip has identical text', () => {
    const view = render('one', 10);
    act(() => view.dispatch({ changes: { from: 3, insert: ' cat' }, selection: { anchor: 7 } }));
    expect(undoDepth(view.state)).toBe(1);
    const next = render('one cat', 20);
    expect(next).toBe(view);
    expect(next.state.doc.toString()).toBe('one cat');
    expect(next.state.selection.main.head).toBe(0);
    expect(undoDepth(next.state)).toBe(0);
  });
  it('opens at the top of the editor', () => {
    const view = render('one');
    act(() => void openSearchPanel(view));
    expect(host.querySelector('.cm-panels-top .cm-search')).not.toBeNull();
    expect(host.querySelector('.cm-panels-bottom')).toBeNull();
  });

  it('stays open, with its query, replacement and options, when another tooltip loads', () => {
    const view = render('one cat');
    act(() => {
      openSearchPanel(view);
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({ search: 'cat', replace: 'dog', caseSensitive: true, wholeWord: true }),
        ),
      });
    });
    const next = render('two cat cat');
    expect(next).toBe(view);
    expect(next.state.doc.toString()).toBe('two cat cat');
    expect(searchPanelOpen(next.state)).toBe(true);
    const query = getSearchQuery(next.state);
    expect([
      query.search,
      query.replace,
      query.caseSensitive,
      query.wholeWord,
      query.regexp,
    ]).toEqual(['cat', 'dog', true, true, false]);
    expect(host.querySelector<HTMLInputElement>('input[name=search]')!.value).toBe('cat');
    expect(host.querySelector<HTMLInputElement>('input[name=replace]')!.value).toBe('dog');
  });

  it('does not take focus from the page when it comes back', () => {
    const view = render('one');
    act(() => void openSearchPanel(view));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    render('two');
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps the caret in the editor when the same editor is rebuilt', () => {
    // Browsers focus a field on select(), which the panel calls when it opens; jsdom does not.
    vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      this.focus();
    });
    const view = render('one');
    act(() => void openSearchPanel(view));
    act(() => view.focus());
    view.contentDOM.focus();
    const before = document.activeElement;
    expect(before).toBe(view.contentDOM);
    render('two');
    expect(document.activeElement).toBe(before);
  });

  it('leaves a second editor that opts out (stored forms) alone', () => {
    const view = render('one');
    act(() => {
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'kept' })) });
    });
    const other = document.createElement('div');
    document.body.append(other);
    const otherRoot = createRoot(other);
    act(() =>
      otherRoot.render(
        <ClarityEditor
          value="stored"
          lang="en"
          globals={globals}
          readOnly
          findMemory={false}
          onChange={() => {}}
        />,
      ),
    );
    const second = EditorView.findFromDOM(other.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(searchPanelOpen(second.state)).toBe(false);
    act(() => void openSearchPanel(second));
    expect(readSearchMemory().search).toBe('kept');
    act(() => otherRoot.unmount());
    other.remove();
  });

  it('survives leaving the page and coming back (a fresh editor)', () => {
    const view = render('one');
    act(() => {
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'x', replace: 'y' })) });
    });
    act(() => root.render(null));
    const again = render('three');
    expect(searchPanelOpen(again.state)).toBe(true);
    expect(getSearchQuery(again.state).search).toBe('x');
    expect(host.querySelector<HTMLInputElement>('input[name=replace]')!.value).toBe('y');
  });

  it('stays closed once the author closed it', () => {
    const view = render('one');
    act(() => void openSearchPanel(view));
    act(() => void closeSearchPanel(view));
    expect(readSearchMemory().open).toBe(false);
    const next = render('two');
    expect(searchPanelOpen(next.state)).toBe(false);
    expect(host.querySelector('.cm-search')).toBeNull();
  });

  it('is kept per tab in session storage', () => {
    const view = render('one');
    act(() => {
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'kept' })) });
    });
    expect(JSON.parse(sessionStorage.getItem('clarity.find')!)).toMatchObject({
      open: true,
      search: 'kept',
    });
  });
});
