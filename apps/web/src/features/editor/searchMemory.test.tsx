// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
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
  it('loads an unedited item with a single transaction and retains its view plugins', () => {
    const view = render('Previous item', 10);
    const update = vi.spyOn(view, 'update');
    const next = render('Newest item', 20);
    expect(next).toBe(view);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toHaveLength(1);
    expect(update.mock.calls[0][0][0].reconfigured).toBe(false);
    expect(view.state.doc.toString()).toBe('Newest item');
  });
  it('keeps live documents mounted while postponing caret movement until stepping ends', () => {
    const changed = vi.fn();
    const show = (value: string, hash: number, stepping: boolean) =>
      act(() =>
        root.render(
          <ClarityEditor
            value={value}
            tooltipHash={hash}
            lang="en"
            globals={globals}
            onChange={changed}
            stepping={stepping}
            markupRow
          />,
        ),
      );
    show('Previous item', 10, false);
    const editorDOM = host.querySelector<HTMLElement>('.cm-editor')!;
    const view = EditorView.findFromDOM(editorDOM)!;
    const toolbar = host.querySelector('[data-markup-row]');
    act(() => view.focus());
    show('Newest item', 20, true);
    expect(host.querySelector('.cm-editor')).toBe(editorDOM);
    expect(host.querySelector('[data-markup-row]')).toBe(toolbar);
    expect(view.state.doc.toString()).toBe('Newest item');
    expect(view.hasFocus).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    show('Newest item', 20, false);
    expect(view.state.selection.main.head).toBe(0);
    expect(view.hasFocus).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });
  it('commits the landed document before layout observers can see the resumed editor', () => {
    const snapshots: string[] = [];
    const changed = vi.fn();
    function Probe({
      hash,
      value,
      suspended = false,
    }: {
      hash: number;
      value: string;
      suspended?: boolean;
    }) {
      useLayoutEffect(() => {
        if (!suspended) snapshots.push(host.querySelector('.cm-content')?.textContent ?? '');
      }, [hash, suspended]);
      return (
        <ClarityEditor
          value={value}
          lang="en"
          tooltipHash={hash}
          globals={globals}
          onChange={changed}
          suspended={suspended}
        />
      );
    }
    act(() => root.render(<Probe hash={10} value="Previous item" />));
    act(() => root.render(<Probe hash={10} value="Previous item" suspended />));
    snapshots.length = 0;
    act(() => root.render(<Probe hash={20} value="Landed item" />));
    expect(snapshots).toEqual(['Landed item']);
    expect(changed).not.toHaveBeenCalled();
  });
  it('does not take focus back from another control after a burst', () => {
    const view = render('one', 10);
    const show = (suspended: boolean) =>
      act(() =>
        root.render(
          <ClarityEditor
            value="one"
            lang="en"
            tooltipHash={10}
            globals={globals}
            onChange={() => {}}
            suspended={suspended}
          />,
        ),
      );
    act(() => view.focus());
    show(true);
    const control = document.createElement('button');
    document.body.append(control);
    control.focus();
    show(false);
    expect(document.activeElement).toBe(control);
    control.remove();
  });

  it('does not create an editor for an initially suspended route', () => {
    const show = (suspended: boolean, value: string) =>
      act(() =>
        root.render(
          <ClarityEditor
            value={value}
            lang="en"
            tooltipHash={20}
            globals={globals}
            onChange={() => {}}
            suspended={suspended}
          />,
        ),
      );
    show(true, 'Skipped');
    expect(host.querySelector('.cm-editor')).toBeNull();
    show(false, 'Landed');
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(view.state.doc.toString()).toBe('Landed');
    expect(undoDepth(view.state)).toBe(0);
  });

  it('detaches the editor through a selection burst without losing its state', () => {
    const view = render('one', 10);
    act(() => view.dispatch({ changes: { from: 3, insert: ' cat' }, selection: { anchor: 7 } }));
    const show = (suspended: boolean) =>
      act(() =>
        root.render(
          <ClarityEditor
            value="one cat"
            lang="en"
            tooltipHash={10}
            globals={globals}
            onChange={() => {}}
            suspended={suspended}
          />,
        ),
      );
    show(true);
    expect(host.querySelector('.cm-editor')).toBeNull();
    expect(view.dom.isConnected).toBe(false);
    show(false);
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)).toBe(view);
    expect(view.state.doc.toString()).toBe('one cat');
    expect(view.state.selection.main.head).toBe(7);
    expect(undoDepth(view.state)).toBe(1);
  });

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
  it('loads a document in place without authoring it or undoing deletions from another item', () => {
    const changed = vi.fn();
    const show = (value: string, tooltipHash: number) =>
      act(() =>
        root.render(
          <ClarityEditor
            value={value}
            tooltipHash={tooltipHash}
            lang="en"
            globals={globals}
            onChange={changed}
          />,
        ),
      );
    show('previous document', 10);
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    const editorDOM = view.dom;
    act(() => view.dispatch({ changes: { from: 0, to: 9 }, userEvent: 'delete' }));
    changed.mockClear();
    const update = vi.spyOn(view, 'update');
    const rebuild = vi.spyOn(view, 'setState');
    show('new document', 20);
    expect(view.dom).toBe(editorDOM);
    expect(update).toHaveBeenCalledOnce();
    expect(rebuild).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
    expect(redoDepth(view.state)).toBe(0);
    expect(undo(view)).toBe(false);
    expect(redo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('new document');
    act(() => view.dispatch({ changes: { from: 12, insert: '!' }, userEvent: 'input.type' }));
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe('new document');
    expect(changed).toHaveBeenLastCalledWith('new document');
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
