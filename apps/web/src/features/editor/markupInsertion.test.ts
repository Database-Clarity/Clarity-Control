import { describe, expect, test } from 'vitest';
import { history, redo, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
  markupColors,
  markupIcons,
  markupLineClasses,
  markupTableClasses,
  parseMarkup,
} from '@clarity/core';
import { markupOptions, markupTransaction, type MarkupOption } from './markupInsertion';

function option(id: string) {
  const found = markupOptions.find((item) => item.id === id);
  if (!found) throw new Error(`Missing markup option ${id}`);
  return found;
}

function insert(state: EditorState, markup: MarkupOption) {
  const transaction = markupTransaction(state, markup);
  if (!transaction) throw new Error('Expected insertion to be supported');
  return transaction.state;
}

describe('markup insertion', () => {
  test('offers the parser-defined inline formats, icons and line styles', () => {
    for (const name of [...markupColors, 'background'])
      expect(option(`inline:${name}`)).toBeTruthy();
    for (const name of markupIcons) expect(option(`icon:${name}`)).toBeTruthy();
    for (const name of markupLineClasses) expect(option(`line:${name}`)).toBeTruthy();
    for (const name of markupTableClasses) expect(option(`table:${name}`)).toBeTruthy();
    expect(new Set(markupOptions.map((item) => item.id)).size).toBe(markupOptions.length);
  });

  test('wraps a backwards selection and preserves its direction', () => {
    const state = EditorState.create({ doc: 'A word Z', selection: { anchor: 6, head: 2 } });
    const next = insert(state, option('inline:bold'));
    expect(next.doc.toString()).toBe('A <bold word /> Z');
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('word');
    expect(next.selection.main.anchor).toBeGreaterThan(next.selection.main.head);
  });

  test('wraps each selected line separately, as the parser requires', () => {
    const state = EditorState.create({ doc: 'one\ntwo', selection: { anchor: 0, head: 7 } });
    const next = insert(state, option('inline:blue'));
    expect(next.doc.toString()).toBe('<blue one />\n<blue two />');
    expect(
      parseMarkup(next.doc.toString()).lines.map((line) => line.linesContent?.[0].text),
    ).toEqual(['one', 'two']);
  });

  test.each([
    ['inline:pve', '<pve Text />'],
    ['link', '<link Text [https://example.com] />'],
    ['title', '<title Text [Name] />'],
  ])('inserts %s with selected editable placeholder', (id, expected) => {
    const state = EditorState.create({ doc: 'abc', selection: { anchor: 1 } });
    const next = insert(state, option(id));
    expect(next.doc.toString()).toBe(`a${expected}bc`);
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('Text');
    expect(markupTransaction(next, option('inline:blue'))).toBeNull();
    const cursor = next.update({ selection: { anchor: next.selection.main.from + 1 } }).state;
    expect(markupTransaction(cursor, option('inline:blue'))).toBeNull();
  });

  test.each([
    ['icon:solar', '<solar/>'],
    ['line:background', '<background/>'],
  ])('%s inserts at the active end without deleting selected text', (id, token) => {
    const state = EditorState.create({ doc: 'abcd', selection: { anchor: 1, head: 3 } });
    expect(insert(state, option(id)).doc.toString()).toBe(`abc${token}d`);
  });

  test('inserts a table as a separate block with selected lines as rows', () => {
    const state = EditorState.create({
      doc: 'Start one\ntwo End',
      selection: { anchor: 6, head: 13 },
    });
    const next = insert(state, option('table:wide'));
    expect(next.doc.toString()).toBe('Start \n< table wide >\n| one\n| two\n<$>\n End');
    expect(parseMarkup(next.doc.toString()).lines.find((line) => line.table)?.table).toHaveLength(
      2,
    );
  });

  test('handles multiple selections and leaves insertion separately undoable and redoable', () => {
    let state = EditorState.create({
      doc: 'one two',
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
      extensions: [history(), EditorState.allowMultipleSelections.of(true)],
    });
    state = insert(state, option('inline:green'));
    expect(state.doc.toString()).toBe('<green one /> <green two />');
    const dispatch = (transaction: { state: EditorState }) => {
      state = transaction.state;
    };
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('one two');
    expect(redo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('<green one /> <green two />');
  });

  test('undoes insertion separately from preceding typing', () => {
    let state = EditorState.create({ doc: '', extensions: history() });
    state = state.update({ changes: { from: 0, insert: 'word' }, userEvent: 'input.type' }).state;
    state = state.update({ selection: { anchor: 0, head: 4 } }).state;
    state = insert(state, option('inline:bold'));
    const dispatch = (transaction: { state: EditorState }) => {
      state = transaction.state;
    };
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('word');
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('');
  });

  test.each(['inline:bold', 'inline:blue', 'link', 'title'])(
    'rejects repeated or mixed %s formatting without changing the preview or history',
    (id) => {
      let state = EditorState.create({
        doc: 'French text',
        selection: { anchor: 0, head: 6 },
        extensions: history(),
      });
      state = insert(state, option('inline:bold'));
      const before = state;
      expect(state.doc.toString()).toBe('<bold French /> text');
      expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('French');
      expect(parseMarkup(state.doc.toString()).lines[0].linesContent).toEqual([
        { text: 'French', classNames: ['bold'] },
        { text: ' text' },
      ]);
      expect(markupTransaction(state, option(id))).toBeNull();
      expect(state).toBe(before);
      const dispatch = (transaction: { state: EditorState }) => {
        state = transaction.state;
      };
      expect(undo({ state, dispatch })).toBe(true);
      expect(state.doc.toString()).toBe('French text');
      expect(redo({ state, dispatch })).toBe(true);
      expect(state.doc.toString()).toBe('<bold French /> text');
    },
  );

  test.each([
    ['<bold French />', 'French'],
    ['<link French [https://example.com] />', 'French'],
    ['<title French [Name] />', 'French'],
  ])('rejects selecting inside or across existing token %s', (token, label) => {
    const doc = `before ${token} after`;
    const start = doc.indexOf(token);
    const content = doc.indexOf(label);
    const selections = [
      [content, content + label.length],
      [content + 1, content + 3],
      [start, start + token.length],
      [start - 2, content + 2],
      [content + 2, start + token.length + 2],
      [start + 1, start + 1],
      [content + 1, content + 1],
      [start + token.length - 1, start + token.length - 1],
    ];
    for (const [anchor, head] of selections) {
      for (const id of ['inline:blue', 'link', 'title', 'table:wide']) {
        const state = EditorState.create({ doc, selection: { anchor, head } });
        expect(markupTransaction(state, option(id)), `${id}: ${anchor}-${head}`).toBeNull();
        expect(state.doc.toString()).toBe(doc);
        expect(parseMarkup(state.doc.toString())).toEqual(parseMarkup(doc));
      }
    }
  });

  test('rejects insertion at an active cursor within a token for icons and line styles', () => {
    const doc = '<link French [https://example.com] /> text';
    for (const id of ['icon:solar', 'line:background']) {
      const state = EditorState.create({ doc, selection: { anchor: doc.length, head: 7 } });
      expect(markupTransaction(state, option(id))).toBeNull();
    }
  });

  test('preserves actual link and title rendering when formatting their labels is declined', () => {
    const globals = { variables: '', titles: 'title Name (\nDescription\n)' };
    for (const [doc, expected] of [
      ['<link French [https://example.com] />', { text: 'French', link: 'https://example.com' }],
      ['<title French [Name] />', { text: 'French', title: expect.any(Array) }],
    ] as const) {
      const state = EditorState.create({
        doc,
        selection: { anchor: doc.indexOf('French'), head: doc.indexOf('French') + 6 },
      });
      expect(markupTransaction(state, option('inline:bold'))).toBeNull();
      expect(parseMarkup(state.doc.toString(), globals).lines[0].linesContent).toEqual([
        expect.objectContaining(expected),
      ]);
    }
  });

  test('protects variable and math references and ambiguous reference labels', () => {
    for (const doc of ['#damage', '${2+2}', '${2+2']) {
      const state = EditorState.create({ doc, selection: { anchor: 1, head: doc.length } });
      expect(markupTransaction(state, option('inline:bold'))).toBeNull();
    }
    for (const id of ['link', 'title']) {
      for (const doc of ['label [other]', '[other]', 'first\n[other]']) {
        const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } });
        expect(markupTransaction(state, option(id))).toBeNull();
        expect(parseMarkup(state.doc.toString()).lines.map((line) => line.linesContent)).toEqual(
          doc.split('\n').map((text) => [{ text }]),
        );
      }
    }
  });

  test('allows selections adjacent to tokens and protects incomplete tokens', () => {
    const doc = '<bold French /> text';
    const adjacent = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('text'), head: doc.length },
    });
    const next = insert(adjacent, option('inline:blue'));
    expect(next.doc.toString()).toBe('<bold French /> <blue text />');
    expect(parseMarkup(next.doc.toString()).lines[0].linesContent).toEqual([
      { text: 'French', classNames: ['bold'] },
      { text: ' ' },
      { text: 'text', classNames: ['blue'] },
    ]);
    const incomplete = EditorState.create({ doc: '<bold French', selection: { anchor: 12 } });
    expect(markupTransaction(incomplete, option('inline:blue'))).toBeNull();
  });

  test('rejects table nesting, table cell delimiters and unsafe mixed multi-selections atomically', () => {
    const doc = '< table wide >\n| one | two\n<$>';
    for (const [anchor, head, id] of [
      [doc.indexOf('one'), doc.indexOf('one') + 3, 'table:wide'],
      [doc.indexOf('one'), doc.indexOf('two') + 3, 'inline:bold'],
      [doc.indexOf('|'), doc.indexOf('|'), 'icon:solar'],
      [0, 0, 'inline:bold'],
    ] as const) {
      expect(
        markupTransaction(EditorState.create({ doc, selection: { anchor, head } }), option(id)),
      ).toBeNull();
    }
    const multi = EditorState.create({
      doc: 'plain <bold word />',
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(12, 16),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(markupTransaction(multi, option('inline:blue'))).toBeNull();
    expect(multi.doc.toString()).toBe('plain <bold word />');
  });
});
