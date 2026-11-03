// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
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
});

function render(value: string) {
  act(() =>
    root.render(
      <ClarityEditor value={value} lang="en" globals={globals} onChange={() => {}} />,
    ),
  );
  return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
}

describe('find and replace persistence', () => {
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
    expect([query.search, query.replace, query.caseSensitive, query.wholeWord, query.regexp]).toEqual(
      ['cat', 'dog', true, true, false],
    );
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
