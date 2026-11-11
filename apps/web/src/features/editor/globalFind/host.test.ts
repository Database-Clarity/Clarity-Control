// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { globalFindExtension, openResult } from './host';
import { FindIndex } from './index';

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));
it('pushes navigation through the existing host and selects the exact loaded match', async () => {
  let hash = 1;
  const navigate = vi.fn();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'old',
      extensions: globalFindExtension({
        lang: 'en',
        globals: { variables: '', titles: '' },
        selfHash: () => hash,
        sources: () => undefined,
        navigate: () => navigate,
      }),
    }),
  });
  views.push(view);
  const index = new FindIndex();
  index.update([
    { hash: 2, name: 'Target', category: 'Perks', categoryId: 'perk', lang: 'en', text: 'A\ncat' },
  ]);
  const result = index.query({ search: 'cat', wholeWord: false, caseSensitive: false, raw: false })
    .results[0];
  openResult(view, result);
  expect(navigate).toHaveBeenCalledWith({ type: 'tooltip', hash: 2, lang: 'en', line: 2 });
  hash = 2;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'A\ncat' } });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(view.state.selection.main).toMatchObject({ from: 2, to: 5 });
  expect(view.state.doc.toString()).toBe('A\ncat');
});
