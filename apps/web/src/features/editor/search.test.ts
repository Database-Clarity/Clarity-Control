// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  search,
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from '@codemirror/search';

test.each([false, true])('search and replace obey read-only: %s', (readOnly) => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'cat cat',
      extensions: [history(), search(), EditorState.readOnly.of(readOnly)],
    }),
  });
  try {
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: 'cat', replace: 'dog' })),
    });
    expect(findNext(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'cat',
    );
    findNext(view);
    expect(view.state.selection.main.from).toBe(4);
    findPrevious(view);
    expect(view.state.selection.main.from).toBe(0);
    replaceNext(view);
    if (readOnly) {
      replaceAll(view);
      expect(view.state.doc.toString()).toBe('cat cat');
    } else {
      expect(view.state.doc.toString()).toBe('dog cat');
      replaceAll(view);
      expect(view.state.doc.toString()).toBe('dog dog');
      undo(view);
      expect(view.state.doc.toString()).toBe('dog cat');
    }
  } finally {
    view.destroy();
  }
});
