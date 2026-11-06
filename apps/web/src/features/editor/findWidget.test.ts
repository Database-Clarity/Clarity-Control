// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { history } from '@codemirror/commands';
import {
  getSearchQuery,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from '@codemirror/search';
import {
  chooseSpot,
  countLabel,
  currentMatch,
  findWidgetExtension,
  findWidgetPanel,
  maxCounted,
  openReplace,
  placeMatch,
  replaceRowOpen,
  type MatchList,
} from './findWidget';
import { readSearchMemory, rememberSearch, resetSearchMemory, restoreSearch } from './searchMemory';

const list = (from: number[], width = 3, capped = false): MatchList => ({
  from,
  to: from.map((start) => start + width),
  capped,
});

describe('count label', () => {
  it('finds the match that is exactly the selection', () => {
    const matches = list([2, 10, 40]);
    expect(currentMatch(matches, 10, 13)).toBe(1);
    expect(currentMatch(matches, 10, 12)).toBe(-1);
    expect(currentMatch(matches, 11, 14)).toBe(-1);
    expect(currentMatch(list([]), 0, 0)).toBe(-1);
  });
  it('reads n of m, ? when the selection is elsewhere, and the empty cases', () => {
    const matches = list([2, 10, 40]);
    expect(countLabel(matches, { from: 40, to: 43 }, 'cat', true)).toBe('3 of 3');
    expect(countLabel(matches, { from: 0, to: 0 }, 'cat', true)).toBe('? of 3');
    expect(countLabel(list([]), { from: 0, to: 0 }, 'cat', true)).toBe('No results');
    expect(countLabel(null, { from: 0, to: 0 }, 'cat', true)).toBe('');
    expect(countLabel(matches, { from: 0, to: 0 }, '', true)).toBe('');
    expect(countLabel(null, { from: 0, to: 0 }, '(', false)).toBe('Invalid');
    expect(countLabel(list([1], 1, true), { from: 1, to: 2 }, 'a', true)).toBe(
      `1 of ${maxCounted}+`,
    );
  });
});

describe('keeping the match in view', () => {
  const editor = { left: 0, right: 1000, top: 0, bottom: 600 };
  const strip = { left: 0, right: 1000, top: 0, bottom: 0 };
  const spot = (
    match: Parameters<typeof chooseSpot>[0]['match'],
    side: 'left' | 'right' = 'right',
  ) => ({
    match,
    editor,
    strip,
    width: 400,
    height: 30,
    pad: { x: 14, left: 8, y: 4 },
    view: 800,
    now: { side },
  });
  it('stays put when the match is clear of it', () => {
    expect(chooseSpot(spot({ left: 20, right: 80, top: 10, bottom: 26 }))).toEqual({
      side: 'right',
      offset: 0,
    });
  });
  it('moves to the other side when the match is under it', () => {
    expect(chooseSpot(spot({ left: 700, right: 760, top: 10, bottom: 26 }))).toEqual({
      side: 'left',
      offset: 0,
    });
    expect(chooseSpot(spot({ left: 100, right: 160, top: 10, bottom: 26 }, 'left'))).toEqual({
      side: 'right',
      offset: 0,
    });
  });
  it('drops below the match when both sides are covered', () => {
    const choice = chooseSpot(spot({ left: 100, right: 900, top: 10, bottom: 26 }));
    expect(choice.side).toBe('right');
    expect(choice.offset).toBe(26 + 4 - 4);
  });
  it('rests where it is when nothing fits (no room below the match)', () => {
    const none = chooseSpot({ ...spot({ left: 0, right: 1000, top: 0, bottom: 20 }), view: 40 });
    expect(none).toEqual({ side: 'right', offset: 0 });
  });
  it('stays below the strip that pins it on a phone', () => {
    const phone = {
      ...spot({ left: 0, right: 1000, top: 104, bottom: 120 }),
      strip: { left: 0, right: 1000, top: 100, bottom: 100 },
      editor: { ...editor, bottom: 900 },
      view: 800,
    };
    expect(chooseSpot(phone)).toEqual({ side: 'right', offset: 120 + 4 - (100 + 4) });
  });
  it('treats a match across lines as the full width', () => {
    const box = placeMatch(
      { left: 300, right: 310, top: 10, bottom: 26 },
      { left: 40, right: 50, top: 26, bottom: 42 },
      editor,
    );
    expect(box).toEqual({ left: 0, right: 1000, top: 10, bottom: 42 });
    expect(
      placeMatch(
        { left: 300, right: 310, top: 10, bottom: 26 },
        { left: 340, right: 350, top: 10, bottom: 26 },
        editor,
      ),
    ).toEqual({ left: 300, right: 350, top: 10, bottom: 26 });
  });
});

describe('find widget', () => {
  let parent: HTMLDivElement;
  let view: EditorView;
  beforeEach(() => {
    resetSearchMemory();
    vi.useFakeTimers();
    parent = document.createElement('div');
    document.body.append(parent);
  });
  afterEach(() => {
    view?.destroy();
    parent.remove();
    vi.useRealTimers();
  });

  function make(doc: string, readOnly = false) {
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          history(),
          search({ top: true, createPanel: findWidgetPanel }),
          findWidgetExtension,
          keymap.of([
            { key: 'Mod-h', run: openReplace, scope: 'editor search-panel' },
            ...searchKeymap,
          ]),
          EditorState.readOnly.of(readOnly),
        ],
      }),
    });
    return view;
  }
  const field = (name: string) => parent.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  const button = (name: string) => parent.querySelector<HTMLButtonElement>(`button[name=${name}]`)!;
  const count = () => parent.querySelector('.fw-count')!.textContent;
  const type = (name: string, value: string) => {
    const input = field(name);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (target: Element, init: KeyboardEventInit) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );

  it('opens as one row with the replace row folded away', () => {
    make('cat cat');
    openSearchPanel(view);
    expect(parent.querySelector('.cm-panels-top .cm-search')).not.toBeNull();
    expect(parent.querySelector('.cm-search')!.getAttribute('data-replace')).toBe('closed');
    expect(button('toggleReplace').getAttribute('aria-expanded')).toBe('false');
    expect(replaceRowOpen(view.state)).toBe(false);
  });

  it('counts after a quiet period, not on the input path', () => {
    make('cat dog cat cat');
    openSearchPanel(view);
    type('search', 'cat');
    expect(getSearchQuery(view.state).search).toBe('cat');
    expect(count()).toBe('');
    vi.advanceTimersByTime(80);
    expect(count()).toBe('? of 3');
    button('next').click();
    expect(count()).toBe('1 of 3');
    button('next').click();
    expect(count()).toBe('2 of 3');
    button('prev').click();
    expect(count()).toBe('1 of 3');
  });

  it('only counts once while the document keeps changing', () => {
    make('cat');
    openSearchPanel(view);
    type('search', 'cat');
    vi.advanceTimersByTime(80);
    expect(count()).toBe('? of 1');
    const now = vi.spyOn(performance, 'now');
    for (let i = 0; i < 5; i++) {
      view.dispatch({ changes: { from: 0, insert: 'cat ' } });
      vi.advanceTimersByTime(20);
    }
    // Still inside the quiet period after the last change: the old text stays, nothing scanned.
    expect(count()).toBe('? of 1');
    expect(now).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(count()).toBe('? of 6');
  });

  it('shows No results and flags an invalid expression', () => {
    make('cat');
    openSearchPanel(view);
    type('search', 'zzz');
    vi.advanceTimersByTime(80);
    expect(count()).toBe('No results');
    button('re').click();
    type('search', '(');
    vi.advanceTimersByTime(80);
    expect(count()).toBe('Invalid');
    expect(field('search').hasAttribute('data-invalid')).toBe(true);
  });

  it('caps the count', () => {
    make('a'.repeat(maxCounted + 500));
    openSearchPanel(view);
    type('search', 'a');
    vi.advanceTimersByTime(500);
    expect(count()).toBe(`? of ${maxCounted}+`);
  });

  it('steps with Enter and Shift+Enter', () => {
    make('cat cat cat');
    openSearchPanel(view);
    type('search', 'cat');
    vi.advanceTimersByTime(80);
    key(field('search'), { key: 'Enter' });
    expect(view.state.selection.main.from).toBe(0);
    key(field('search'), { key: 'Enter' });
    expect(view.state.selection.main.from).toBe(4);
    key(field('search'), { key: 'Enter', shiftKey: true });
    expect(view.state.selection.main.from).toBe(0);
  });

  it('replaces one match with Enter in the replace field, then all', () => {
    make('cat cat cat');
    openSearchPanel(view);
    type('search', 'cat');
    button('toggleReplace').click();
    type('replace', 'dog');
    // The first press lands on the match, the next replaces it (CodeMirror and VS Code alike).
    key(field('replace'), { key: 'Enter' });
    expect(view.state.doc.toString()).toBe('cat cat cat');
    key(field('replace'), { key: 'Enter' });
    expect(view.state.doc.toString()).toBe('dog cat cat');
    button('replaceAll').click();
    expect(view.state.doc.toString()).toBe('dog dog dog');
  });

  it('replaces with a regular expression and honours case', () => {
    make('Cat cat CAT');
    openSearchPanel(view);
    type('search', 'cat');
    type('replace', 'dog');
    button('toggleReplace').click();
    button('case').click();
    expect(button('case').getAttribute('aria-pressed')).toBe('true');
    button('replaceAll').click();
    expect(view.state.doc.toString()).toBe('Cat dog CAT');
    button('case').click();
    type('search', 'd(o)g');
    button('re').click();
    type('replace', '$1$1');
    button('replaceAll').click();
    expect(view.state.doc.toString()).toBe('Cat oo CAT');
  });

  it('toggles with Alt+C, Alt+W, Alt+R', () => {
    make('cat');
    openSearchPanel(view);
    key(field('search'), { key: 'c', altKey: true });
    key(field('search'), { key: 'w', altKey: true });
    key(field('search'), { key: 'r', altKey: true });
    const query = getSearchQuery(view.state);
    expect([query.caseSensitive, query.wholeWord, query.regexp]).toEqual([true, true, true]);
  });

  it('Ctrl+H opens the replace row and focuses the replace field', () => {
    make('cat');
    expect(openReplace(view)).toBe(true);
    expect(parent.querySelector('.cm-search')!.getAttribute('data-replace')).toBe('open');
    expect(replaceRowOpen(view.state)).toBe(true);
    expect(document.activeElement).toBe(field('replace'));
    // Chevron folds it back and returns to the find field.
    button('toggleReplace').click();
    expect(parent.querySelector('.cm-search')!.getAttribute('data-replace')).toBe('closed');
    expect(replaceRowOpen(view.state)).toBe(false);
    expect(document.activeElement).toBe(field('search'));
  });

  it('Escape closes it and gives the editor focus back', () => {
    make('cat');
    view.focus();
    openSearchPanel(view);
    expect(document.activeElement).toBe(field('search'));
    key(field('search'), { key: 'Escape' });
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(parent.querySelector('.cm-search')).toBeNull();
  });

  it('closes from its button', () => {
    make('cat');
    openSearchPanel(view);
    button('closeFind').click();
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('has no replace controls in a read-only editor', () => {
    make('cat', true);
    openSearchPanel(view);
    expect(parent.querySelector('input[name=replace]')).toBeNull();
    expect(parent.querySelector('button[name=toggleReplace]')).toBeNull();
    expect(parent.querySelector('button[name=replaceAll]')).toBeNull();
    expect(openReplace(view)).toBe(true);
  });

  it('remembers the replace row with the rest of the find state', () => {
    make('cat');
    openReplace(view);
    type('search', 'cat');
    expect(readSearchMemory()).toMatchObject({ open: false });
    rememberSearch({
      state: view.state,
      startState: EditorState.create({ doc: 'cat' }),
    } as unknown as ViewUpdate);
    expect(readSearchMemory()).toMatchObject({ open: true, replaceOpen: true, search: 'cat' });
    view.destroy();
    parent.replaceChildren();
    make('dog');
    restoreSearch(view);
    expect(parent.querySelector('.cm-search')!.getAttribute('data-replace')).toBe('open');
    expect(field('search').value).toBe('cat');
    resetSearchMemory();
  });
});
