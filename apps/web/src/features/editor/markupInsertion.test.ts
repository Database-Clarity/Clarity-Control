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
import { markupOptions, markupTransaction } from './markupInsertion';

function option(id: string) {
  const found = markupOptions.find((item) => item.id === id);
  if (!found) throw new Error(`Missing markup option ${id}`);
  return found;
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
    const next = markupTransaction(state, option('inline:bold')).state;
    expect(next.doc.toString()).toBe('A <bold word /> Z');
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('word');
    expect(next.selection.main.anchor).toBeGreaterThan(next.selection.main.head);
  });

  test('wraps each selected line separately, as the parser requires', () => {
    const state = EditorState.create({ doc: 'one\ntwo', selection: { anchor: 0, head: 7 } });
    const next = markupTransaction(state, option('inline:blue')).state;
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
    const next = markupTransaction(state, option(id)).state;
    expect(next.doc.toString()).toBe(`a${expected}bc`);
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('Text');
  });

  test.each([
    ['icon:solar', '<solar/>'],
    ['line:background', '<background/>'],
  ])('%s inserts at the active end without deleting selected text', (id, token) => {
    const state = EditorState.create({ doc: 'abcd', selection: { anchor: 1, head: 3 } });
    expect(markupTransaction(state, option(id)).state.doc.toString()).toBe(`abc${token}d`);
  });

  test('inserts a table as a separate block with selected lines as rows', () => {
    const state = EditorState.create({
      doc: 'Start one\ntwo End',
      selection: { anchor: 6, head: 13 },
    });
    const next = markupTransaction(state, option('table:wide')).state;
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
    state = markupTransaction(state, option('inline:green')).state;
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
    state = markupTransaction(state, option('inline:bold')).state;
    const dispatch = (transaction: { state: EditorState }) => {
      state = transaction.state;
    };
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('word');
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe('');
  });
});
