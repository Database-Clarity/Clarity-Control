// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { snippetLang, useSnippetCatalogue } from '../suggest/custom';
import { markupEntries } from './entries';

afterEach(() => useSnippetCatalogue.setState({ account: null, byLang: {} }));
it.each([
  ['inline:bold', 'bold', '<bold Wörter />'],
  ['inline:exotic', 'exotic', '<exotic Wörter />'],
  ['link', 'link', '<link Wörter [https://example.com] />'],
  ['title', 'title', '<title Wörter [Name] />'],
])(
  'inserts localized words through %s, retaining selection wrapping and English fallback',
  (id, tag, expected) => {
    const suffix =
      tag === 'link' ? ' [{{2:https://example.com}}]' : tag === 'title' ? ' [{{2:Name}}]' : '';
    const words = {
      label: 'Wörter',
      keywords: '',
      template: `<${tag} {{1:Wörter}}${suffix} />`,
      english: false,
    };
    useSnippetCatalogue.setState({
      byLang: { de: { mine: [], team: [], local: new Map([[`tag:${tag}`, words]]) } },
    });
    for (const [lang, selected, english] of [
      ['de', '', false],
      ['en', '', false],
      ['de', 'Selected', false],
      ['de', '', true],
    ] as const) {
      words.english = english;
      const view = new EditorView({
        state: EditorState.create({
          doc: selected,
          selection: EditorSelection.range(0, selected.length),
          extensions: [snippetLang.of(lang)],
        }),
      });
      try {
        const entry = markupEntries({ variables: '', titles: '' }).find(
          (entry) => entry.id === id,
        )!;
        expect(entry.run(view, { variables: '', titles: '' })).toBe('inserted');
        expect(view.state.doc.toString()).toBe(
          expected.replace('Wörter', selected || (lang === 'de' && !english ? 'Wörter' : 'Text')),
        );
        expect(
          view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
        ).toBe(selected || (lang === 'de' && !english ? 'Wörter' : 'Text'));
      } finally {
        view.destroy();
      }
    }
  },
);
