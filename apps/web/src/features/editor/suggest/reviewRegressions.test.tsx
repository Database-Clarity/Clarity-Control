// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, expect, test, vi } from 'vitest';
import { SuggestMenu } from './SuggestMenu';
import { requestItems, suggestContext } from './source';
import {
  openSuggest,
  suggestConfiguration,
  suggestExtension,
  suggestState,
  type SuggestSnapshot,
} from './state';

vi.mock('../../preview/TooltipPreview', () => ({ MarkupSnippet: () => null }));

const globals = { variables: 'var damage = 25', titles: '' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('Ctrl+Space upgrades an automatically opened menu to the full requested menu', () => {
  const view = new EditorView({
    state: EditorState.create({
      extensions: [suggestExtension(), suggestConfiguration({ globals })],
    }),
  });
  try {
    view.dispatch({
      changes: { from: 0, insert: '#' },
      selection: { anchor: 1 },
      userEvent: 'input.type',
    });
    expect(suggestState(view.state)?.explicit).toBe(false);
    runScopeHandlers(
      view,
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true }),
      'editor',
    );
    expect(suggestState(view.state)?.explicit).toBe(true);
    expect(suggestState(view.state)?.items.some((item) => item.id === 'tag:bold')).toBe(true);
  } finally {
    view.destroy();
  }
});

test('filtering a deeply scrolled requested list does not crash the menu', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {});
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.hasAttribute('data-suggest-heading') ? 20 : 24;
    return { left: 0, right: 800, top: 0, bottom: 600, width: 800, height } as DOMRect;
  });
  const scroller = document.createElement('div');
  const view = {
    coordsAtPos: () => ({ left: 10, right: 11, top: 100, bottom: 116 }),
    scrollDOM: scroller,
  } as unknown as EditorView;
  const state = EditorState.create({ doc: 'Gains ', selection: { anchor: 6 } });
  const context = suggestContext(state, true)!;
  const items = requestItems(context, state, globals);
  const snapshot: SuggestSnapshot = {
    context,
    items,
    index: 0,
    explicit: true,
    message: null,
    judged: true,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: SuggestSnapshot) =>
    root.render(<SuggestMenu snapshot={next} view={view} globals={globals} lang="en" />);
  try {
    act(() => render(snapshot));
    act(() => vi.advanceTimersByTime(100));
    const list = document.getElementById('editor-suggest-list')!;
    act(() => {
      list.scrollTop = 900;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(list.querySelector('[role=option]')?.getAttribute('aria-posinset')).not.toBe('1');
    const filteredState = EditorState.create({ doc: 'Gains li', selection: { anchor: 8 } });
    const filteredContext = suggestContext(filteredState, true)!;
    const filtered = {
      ...snapshot,
      context: filteredContext,
      items: requestItems(filteredContext, filteredState, globals),
    };
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.length).toBeLessThan(20);
    expect(() => act(() => render(filtered))).not.toThrow();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

test('typing after opening the no-match fallback keeps the requested menu available', () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'Reload qqqq',
      selection: { anchor: 11 },
      extensions: [suggestExtension(), suggestConfiguration({ globals })],
    }),
  });
  try {
    openSuggest(view);
    expect(suggestState(view.state)).not.toBeNull();
    view.dispatch({
      changes: { from: 11, insert: 's' },
      selection: { anchor: 12 },
      userEvent: 'input.type',
    });
    expect(suggestState(view.state)).not.toBeNull();
  } finally {
    view.destroy();
  }
});
