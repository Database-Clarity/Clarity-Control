import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { history, redo, undo, undoDepth } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
  markupColors,
  markupIcons,
  markupLineClasses,
  markupTableClasses,
  parseMarkup,
  type MarkupGlobals,
} from '@clarity/core';
import { markupOptions, markupTransaction, type MarkupOption } from './markupInsertion';
import { TooltipPreview } from '../preview/TooltipPreview';

const globals = { variables: '', titles: 'title Name (\nDescription\n)' };

function preview(text: string, previewGlobals: MarkupGlobals = globals) {
  return renderToStaticMarkup(
    createElement(TooltipPreview, { text, globals: previewGlobals, lang: 'fr', name: 'Fixture' }),
  );
}

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
      for (const doc of [
        'label [other]',
        '[other]',
        'label[other]',
        'label[unfinished',
        'label\t[other]',
        'label\u00a0[other]',
        'first\n[other]',
      ]) {
        const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } });
        expect(markupTransaction(state, option(id))).toBeNull();
        expect(parseMarkup(state.doc.toString()).lines.map((line) => line.linesContent)).toEqual(
          doc.split('\n').map((text) => [{ text }]),
        );
        expect(preview(state.doc.toString())).not.toContain('Unsafe link omitted');
      }
    }
  });

  test.each(['inline:bold', 'inline:blue', 'link', 'title', 'icon:solar', 'line:background'])(
    'protects a renderer token after a literal greater-than sign from %s',
    (id) => {
      let state = EditorState.create({
        doc: 'Damage > 10',
        selection: { anchor: 0, head: 11 },
        extensions: history(),
      });
      state = insert(state, option('inline:bold'));
      const doc = state.doc.toString();
      expect(doc).toBe('<bold Damage > 10 />');
      const ten = doc.indexOf('10');
      for (const [anchor, head] of [
        [ten, ten + 2],
        [ten + 2, ten],
        [ten, ten],
        [ten + 1, ten + 1],
        [ten + 2, ten + 2],
        [ten - 1, doc.length - 1],
        [doc.length, ten],
      ]) {
        const selected = state.update({ selection: { anchor, head } }).state;
        const before = preview(selected.doc.toString());
        expect(markupTransaction(selected, option(id)), `${id}: ${anchor}-${head}`).toBeNull();
        expect(selected.selection.main.anchor).toBe(anchor);
        expect(selected.selection.main.head).toBe(head);
        expect(preview(selected.doc.toString())).toBe(before);
        expect(before).toContain('Damage &gt; 10');
        expect(before).not.toContain('&lt;blue');
      }
      const dispatch = (transaction: { state: EditorState }) => {
        state = transaction.state;
      };
      expect(undo({ state, dispatch })).toBe(true);
      expect(state.doc.toString()).toBe('Damage > 10');
      expect(redo({ state, dispatch })).toBe(true);
      expect(preview(state.doc.toString())).toContain('Damage &gt; 10');
    },
  );

  test('protects parser boundaries after stripped line markers and in reference targets', () => {
    for (const doc of [
      '<bold Damage > <blue/> 10 />',
      '<link label [https://example.com/a>b] />',
      '<title label > 10 [Name] />',
      '< table wide >\n| <bold Damage > <background/> 10 />\n<$>',
    ]) {
      const point = doc.includes('example.com') ? doc.indexOf('>b') + 1 : doc.indexOf('10');
      const state = EditorState.create({ doc, selection: { anchor: point, head: point + 1 } });
      for (const id of ['inline:blue', 'icon:solar', 'line:background']) {
        expect(markupTransaction(state, option(id)), `${id}: ${doc}`).toBeNull();
      }
      const html = preview(state.doc.toString());
      expect(html).not.toContain('&lt;blue 10');
      if (doc.startsWith('<link')) {
        expect(parseMarkup(doc, globals).lines[0].linesContent?.[0].link).toBe(
          'https://example.com/a>b',
        );
        expect(html).toContain('href="https://example.com/a&gt;b"');
      }
      if (doc.startsWith('<title')) {
        expect(parseMarkup(doc, globals).lines[0].linesContent?.[0].title).toBeDefined();
        expect(html).toContain('role="tooltip"');
        expect(html).toContain('Description');
      }
    }
    const incomplete = '<bold Damage > 10';
    const state = EditorState.create({
      doc: incomplete,
      selection: { anchor: incomplete.length },
    });
    expect(markupTransaction(state, option('inline:blue'))).toBeNull();
  });

  test('allows adjacent text but rejects mixed selections after an internal greater-than sign', () => {
    const doc = '<bold Damage > 10 /> plain';
    const start = doc.indexOf('plain');
    const adjacent = EditorState.create({ doc, selection: { anchor: start, head: doc.length } });
    const next = insert(adjacent, option('inline:blue'));
    expect(parseMarkup(next.doc.toString()).lines[0].linesContent).toEqual([
      { text: 'Damage > 10', classNames: ['bold'] },
      { text: ' ' },
      { text: 'plain', classNames: ['blue'] },
    ]);
    expect(preview(next.doc.toString())).toContain('Damage &gt; 10');
    const multi = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.range(doc.indexOf('10'), doc.indexOf('10') + 2),
        EditorSelection.range(start, doc.length),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(markupTransaction(multi, option('inline:blue'))).toBeNull();
    expect(multi.doc.toString()).toBe(doc);
    expect(multi.selection.ranges).toHaveLength(2);
  });

  test('preserves resolvable link and title targets for unambiguous labels', () => {
    for (const id of ['link', 'title']) {
      const state = EditorState.create({
        doc: 'label > other]',
        selection: { anchor: 0, head: 14 },
      });
      const next = insert(state, option(id));
      const parsed = parseMarkup(next.doc.toString(), globals).lines[0].linesContent?.[0];
      const html = preview(next.doc.toString());
      if (id === 'link') {
        expect(parsed?.link).toBe('https://example.com');
        expect(html).toContain('href="https://example.com"');
        expect(html).not.toContain('Unsafe link omitted');
      } else {
        expect(parsed?.title?.[0].linesContent?.[0].text).toBe('Description');
        expect(html).toContain('role="tooltip"');
        expect(html).toContain('Description');
      }
      expect(html).toContain('label &gt; other]');
    }
  });

  test.each(['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue'])(
    'rejects %s throughout a multiline-comment-joined renderer token',
    (id) => {
      const doc = '<bold Damage > /*\nignored\n*/10 />';
      const ten = doc.indexOf('10');
      const comment = doc.indexOf('ignored');
      const selections = [
        [ten, ten + 2],
        [ten + 2, ten],
        [ten + 1, ten + 1],
        [comment, comment],
        [doc.indexOf('Damage'), ten + 2],
        [ten + 2, doc.indexOf('Damage')],
      ];
      for (const [anchor, head] of selections) {
        let state = EditorState.create({ doc: '', extensions: history() });
        state = state.update({ changes: { from: 0, insert: doc }, userEvent: 'input.type' }).state;
        state = state.update({ selection: { anchor, head } }).state;
        const depth = undoDepth(state);
        const before = preview(doc);
        expect(before).toContain('Damage &gt; 10');
        expect(before).not.toContain('ignored');
        expect(markupTransaction(state, option(id)), `${id}: ${anchor}-${head}`).toBeNull();
        expect(state.doc.toString()).toBe(doc);
        expect(state.selection.main.anchor).toBe(anchor);
        expect(state.selection.main.head).toBe(head);
        expect(undoDepth(state)).toBe(depth);
        expect(preview(state.doc.toString())).toBe(before);
      }
    },
  );

  test('protects comment boundaries atomically without blocking unrelated lines', () => {
    const doc = 'before\n<link label /* comment\nhidden\n*/ [https://example.com] />\nafter';
    const target = doc.indexOf('example');
    const after = doc.indexOf('after');
    const multi = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.range(target, target + 3),
        EditorSelection.range(after, after + 5),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(markupTransaction(multi, option('inline:blue'))).toBeNull();
    expect(preview(doc)).toContain('href="https://example.com"');
    const safe = EditorState.create({ doc, selection: { anchor: after, head: after + 5 } });
    const next = insert(safe, option('inline:blue'));
    expect(next.doc.toString()).toContain('/* comment\nhidden\n*/');
    expect(preview(next.doc.toString())).toContain('href="https://example.com"');
    expect(preview(next.doc.toString())).toContain('after');
  });

  test('rejects wrapping a newline that touches a comment-joined line', () => {
    const doc = 'before\n<bold x /*\nhidden\n*/ y />\nafter';
    const lineStart = doc.indexOf('<bold');
    const lineEnd = doc.lastIndexOf('\n');
    for (const [anchor, head] of [
      [0, lineStart],
      [lineEnd, doc.length],
    ]) {
      const state = EditorState.create({ doc, selection: { anchor, head } });
      expect(markupTransaction(state, option('inline:blue'))).toBeNull();
      expect(preview(doc)).not.toContain('hidden');
    }
  });

  test('protects renderer context on lines containing expanded variable or math references', () => {
    for (const doc of [
      'var style = <blue/>\n#style French text',
      'var opener = <bold \n#opener 10 />',
      'French ${2+2} text',
    ]) {
      const start = doc.lastIndexOf('\n') + 1;
      const state = EditorState.create({ doc, selection: { anchor: doc.length } });
      for (const id of ['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue']) {
        expect(markupTransaction(state, option(id)), `${id}: ${doc}`).toBeNull();
      }
      const selection = state.update({ selection: { anchor: start, head: doc.length } }).state;
      expect(markupTransaction(selection, option('inline:bold'))).toBeNull();
      expect(preview(selection.doc.toString())).toBe(preview(doc));
    }
  });

  test.each(['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue'])(
    'rejects %s when a global variable creates a multiline comment',
    (id) => {
      const doc = '<bold Damage > #join\nignored\n*/10 />';
      const expandedGlobals = { variables: 'var join = /*', titles: '' };
      const point = doc.indexOf('10');
      const state = EditorState.create({ doc, selection: { anchor: point, head: point + 2 } });
      expect(parseMarkup(doc, expandedGlobals).lines[0].linesContent).toEqual([
        { text: 'Damage > 10', classNames: ['bold'] },
      ]);
      expect(markupTransaction(state, option(id), expandedGlobals)).toBeNull();
      expect(state.doc.toString()).toBe(doc);
    },
  );

  test('protects comment boundaries created by empty variables and imported text', () => {
    const doc = '/#empty* hidden\n*/visible';
    const globals = { variables: 'var empty = empty', titles: '' };
    const state = EditorState.create({ doc, selection: { anchor: doc.indexOf('visible') } });
    expect(parseMarkup(doc, globals).lines[0].linesContent?.[0].text).toBe('visible');
    expect(markupTransaction(state, option('line:blue'), globals)).toBeNull();
    const imported = EditorState.create({
      doc: 'import main from 42\nplain',
      selection: { anchor: 25 },
    });
    expect(markupTransaction(imported, option('inline:bold'))).toBeNull();
  });

  test.each(['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue'])(
    'allows %s on independent plain text with harmless expansions and standalone comments',
    (id) => {
      const cases: { doc: string; globals: MarkupGlobals; expected?: string }[] = [
        {
          doc: 'var url = https://example.com\nplain\n<link label [#url] />',
          globals,
          expected: 'href="https://example.com"',
        },
        {
          doc: 'plain\n<link label [#url] />',
          globals: { ...globals, variables: 'var url = https://example.com' },
          expected: 'href="https://example.com"',
        },
        {
          doc: 'import main from 42\nplain',
          globals: { ...globals, imports: { '42': 'Imported text' } },
          expected: 'Imported text',
        },
        { doc: '// translator note\nplain', globals },
        { doc: '/* translator note */\nplain', globals },
      ];
      for (const fixture of cases) {
        const point = fixture.doc.indexOf('plain');
        const state = EditorState.create({
          doc: fixture.doc,
          selection: { anchor: point, head: point + 5 },
          extensions: history(),
        });
        expect(parseMarkup(fixture.doc, fixture.globals).diagnostics).toEqual([]);
        const transaction = markupTransaction(state, option(id), fixture.globals);
        expect(transaction, `${id}: ${fixture.doc}`).not.toBeNull();
        const next = transaction!.state;
        const html = preview(next.doc.toString(), fixture.globals);
        expect(html).toContain('plain');
        if (fixture.expected) expect(html).toContain(fixture.expected);
        expect(undoDepth(next)).toBe(1);
      }
    },
  );

  test.each(['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue'])(
    'rejects %s when an expansion creates a comment or is unresolved',
    (id) => {
      const cases: { doc: string; globals: MarkupGlobals }[] = [
        {
          doc: '<bold Damage > #join\nignored\n*/10 />',
          globals: { ...globals, variables: 'var join = /*' },
        },
        {
          doc: '/#empty* hidden\n*/visible',
          globals: { ...globals, variables: 'var empty = empty' },
        },
        { doc: 'import main from 42\nplain', globals },
        { doc: 'import main from 42\nplain', globals: { ...globals, imports: { '42': '/*' } } },
        { doc: '#unknown\nplain', globals },
      ];
      for (const fixture of cases) {
        const point = fixture.doc.includes('10')
          ? fixture.doc.indexOf('10')
          : fixture.doc.includes('visible')
            ? fixture.doc.indexOf('visible')
            : fixture.doc.indexOf('plain');
        const state = EditorState.create({
          doc: fixture.doc,
          selection: { anchor: point, head: point + 1 },
          extensions: history(),
        });
        const before = preview(fixture.doc, fixture.globals);
        expect(markupTransaction(state, option(id), fixture.globals), fixture.doc).toBeNull();
        expect(state.doc.toString()).toBe(fixture.doc);
        expect(state.selection.main.anchor).toBe(point);
        expect(undoDepth(state)).toBe(0);
        expect(preview(state.doc.toString(), fixture.globals)).toBe(before);
      }
    },
  );

  test.each(['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue'])(
    'protects title definition boundaries from %s but allows supported body formatting',
    (id) => {
      const doc = 'title Name (\nDescription\n)\n<title label [Name] />';
      const localGlobals = { variables: '', titles: '' };
      const point = doc.indexOf('Name');
      const initial = preview(doc, localGlobals);
      expect(initial).toContain('role="tooltip"');
      expect(initial).toContain('Description');
      for (const [anchor, head] of [
        [point, point + 4],
        [point + 4, point],
        [point + 2, point + 2],
        [doc.indexOf('('), doc.indexOf('(')],
        [doc.indexOf('\n)') + 1, doc.indexOf('\n)') + 1],
      ]) {
        const state = EditorState.create({
          doc,
          selection: { anchor, head },
          extensions: history(),
        });
        expect(
          markupTransaction(state, option(id), localGlobals),
          `${id}: ${anchor}-${head}`,
        ).toBeNull();
        expect(state.selection.main.anchor).toBe(anchor);
        expect(state.selection.main.head).toBe(head);
        expect(undoDepth(state)).toBe(0);
        expect(preview(state.doc.toString(), localGlobals)).toBe(initial);
        expect(
          parseMarkup(state.doc.toString(), localGlobals).lines[0].linesContent?.[0].title,
        ).toBeDefined();
      }
      const body = doc.indexOf('Description');
      const state = EditorState.create({ doc, selection: { anchor: body, head: body + 11 } });
      const next = markupTransaction(state, option('inline:blue'), localGlobals);
      expect(next).not.toBeNull();
      const html = preview(next!.state.doc.toString(), localGlobals);
      expect(html).toContain('role="tooltip"');
      expect(html).toContain('Description');
      expect(
        parseMarkup(next!.state.doc.toString(), localGlobals).lines[0].linesContent?.[0].title?.[0]
          .linesContent?.[0],
      ).toEqual({ text: 'Description', classNames: ['blue'] });
    },
  );

  test('protects declaration and condition headers without blocking their body text', () => {
    for (const doc of [
      'var damage = 10\nplain',
      'import main from 42\nplain',
      'export Name (\nplain\n)',
      'enhanced (\nplain\n)',
    ]) {
      const fixtureGlobals = { ...globals, imports: { '42': 'Imported text' } };
      const state = EditorState.create({ doc, selection: { anchor: 2, head: 5 } });
      expect(markupTransaction(state, option('inline:blue'), fixtureGlobals), doc).toBeNull();
    }
  });

  test('rejects links in prepared table cells atomically while retaining supported cell actions', () => {
    for (const doc of [
      '< table wide >\n| plain\n<$>',
      '< table /* hidden\n*/wide >\n| plain\n<$>',
      'var kind = table\n< #kind wide >\n| plain\n<$>',
    ]) {
      const point = doc.indexOf('plain');
      for (const [anchor, head] of [
        [point, point + 5],
        [point + 5, point],
        [point + 2, point + 2],
      ]) {
        const state = EditorState.create({
          doc,
          selection: { anchor, head },
          extensions: history(),
        });
        const before = preview(doc);
        expect(markupTransaction(state, option('link'))).toBeNull();
        expect(state.selection.main.anchor).toBe(anchor);
        expect(state.selection.main.head).toBe(head);
        expect(undoDepth(state)).toBe(0);
        expect(preview(state.doc.toString())).toBe(before);
        expect(before).not.toContain('<a ');
      }
      for (const id of ['inline:blue', 'title', 'icon:solar', 'line:bold']) {
        const state = EditorState.create({ doc, selection: { anchor: point, head: point + 5 } });
        const next = insert(state, option(id));
        const html = preview(next.doc.toString());
        expect(html).toContain('plain');
        if (id === 'title') {
          expect(html).toContain('role="tooltip"');
          expect(html).toContain('Description');
        }
      }
      const withPlain = `${doc}\noutside`;
      const outside = withPlain.indexOf('outside');
      const multi = EditorState.create({
        doc: withPlain,
        selection: EditorSelection.create([
          EditorSelection.range(point, point + 5),
          EditorSelection.range(outside, outside + 7),
        ]),
        extensions: [history(), EditorState.allowMultipleSelections.of(true)],
      });
      expect(markupTransaction(multi, option('link'))).toBeNull();
      expect(multi.doc.toString()).toBe(withPlain);
      expect(undoDepth(multi)).toBe(0);
      expect(multi.selection.ranges).toHaveLength(2);
      const nested = EditorState.create({ doc, selection: { anchor: point, head: point + 5 } });
      expect(markupTransaction(nested, option('table:wide'))).toBeNull();
      const delimiter = EditorState.create({
        doc,
        selection: { anchor: doc.indexOf('|'), head: point + 5 },
      });
      expect(markupTransaction(delimiter, option('inline:blue'))).toBeNull();
    }
  });

  test('declines repeated and existing line markers without altering history or preview', () => {
    let state = EditorState.create({ doc: 'French text', extensions: history() });
    state = insert(state, option('line:blue'));
    expect(state.doc.toString()).toBe('<blue/>French text');
    const before = preview(state.doc.toString());
    const depth = undoDepth(state);
    expect(before).toContain('French text');
    expect(before).not.toContain('&lt;blue/&gt;');
    expect(markupTransaction(state, option('line:blue'))).toBeNull();
    expect(undoDepth(state)).toBe(depth);
    const dispatch = (transaction: { state: EditorState }) => {
      state = transaction.state;
    };
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('French text');
    expect(redo({ state, dispatch })).toBe(true);
    expect(preview(state.doc.toString())).toBe(before);

    const elsewhere = EditorState.create({
      doc: 'French <blue/>text',
      selection: { anchor: 0 },
    });
    expect(markupTransaction(elsewhere, option('line:blue'))).toBeNull();
    expect(preview(elsewhere.doc.toString())).not.toContain('&lt;blue/&gt;');
  });

  test('allows renderer-supported mixed styles, bold capacity and repeated icons', () => {
    let state = EditorState.create({ doc: 'French text' });
    state = insert(state, option('line:blue'));
    state = insert(state, option('line:green'));
    state = insert(state, option('line:bold'));
    state = insert(state, option('line:bold'));
    expect(markupTransaction(state, option('line:bold'))).toBeNull();
    state = insert(state, option('icon:solar'));
    state = insert(state, option('icon:solar'));
    const parsed = parseMarkup(state.doc.toString()).lines[0];
    expect(parsed.classNames).toEqual(expect.arrayContaining(['blue', 'green', 'bold']));
    expect(parsed.linesContent?.filter((part) => part.classNames?.includes('solar'))).toHaveLength(
      2,
    );
    expect(preview(state.doc.toString())).toContain('French text');
    expect(preview(state.doc.toString())).not.toContain('&lt;bold/&gt;');
  });

  test('preserves existing line colors and references when wrapping plain multiline text', () => {
    const doc = '<blue/>one\nsecond\n<link target [https://example.com] />';
    const start = doc.indexOf('one');
    const end = doc.indexOf('\n<link');
    const state = EditorState.create({ doc, selection: { anchor: end, head: start } });
    const next = insert(state, option('inline:bold'));
    const lines = parseMarkup(next.doc.toString()).lines;
    expect(lines[0].classNames).toContain('blue');
    expect(lines[0].linesContent).toEqual([{ text: 'one', classNames: ['bold'] }]);
    expect(lines[1].linesContent).toEqual([{ text: 'second', classNames: ['bold'] }]);
    expect(lines[2].linesContent?.[0].link).toBe('https://example.com');
    expect(next.selection.main.anchor).toBeGreaterThan(next.selection.main.head);
    expect(preview(next.doc.toString())).toContain('href="https://example.com"');
  });

  test('checks line-style capacity per renderer table row and multiple cursor', () => {
    const doc = '< table wide >\n| one\n| two\n<$>';
    const first = doc.indexOf('one');
    const row = EditorState.create({ doc, selection: { anchor: first } });
    expect(markupTransaction(row, option('line:blue'))).toBeNull();
    const styled = insert(row, option('line:bold'));
    expect(parseMarkup(styled.doc.toString()).lines[0].table?.[0].classNames).toContain('bold');
    expect(markupTransaction(styled, option('line:bold'))).toBeNull();
    expect(preview(styled.doc.toString())).not.toContain('&lt;bold/&gt;');
    const second = styled.update({
      selection: { anchor: styled.doc.toString().indexOf('two') },
    }).state;
    expect(insert(second, option('line:bold')).doc.toString()).toContain('| <bold/>two');

    const multi = EditorState.create({
      doc: 'one two',
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(markupTransaction(multi, option('line:blue'))).toBeNull();
    expect(multi.doc.toString()).toBe('one two');
  });

  test.each(['inline:blue', 'link', 'title', 'table:wide', 'icon:solar', 'line:blue'])(
    'protects table delimiter edges from %s',
    (id) => {
      const doc = '< table wide >\n| one\n<$>';
      for (const point of [0, doc.indexOf('\n'), doc.indexOf('<$>'), doc.length]) {
        const state = EditorState.create({ doc, selection: { anchor: point } });
        expect(markupTransaction(state, option(id)), `${id}: ${point}`).toBeNull();
        expect(preview(state.doc.toString())).toContain('one');
      }
    },
  );

  test('recognizes table rows when comments join a table header', () => {
    const doc = '< table /* hidden\n*/wide >\n| one\n<$>';
    const row = EditorState.create({ doc, selection: { anchor: doc.indexOf('one') } });
    expect(markupTransaction(row, option('line:blue'))).toBeNull();
    const next = insert(row, option('line:bold'));
    expect(parseMarkup(next.doc.toString()).lines[0].table?.[0].classNames).toContain('bold');
    expect(preview(next.doc.toString())).not.toContain('&lt;bold/&gt;');
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
