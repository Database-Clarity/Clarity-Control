import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { markupLanguage, type MarkupGlobals } from '@clarity/core';
import { clarityCompletions } from './completion';
import { formatMarkupTables, tableFormattingTransaction } from './formatTable';

const globals: MarkupGlobals = {
  variables: 'var damage = 25\nvar duration = 10',
  titles: 'title Details (\nMore details\n)',
  imports: { '1': 'export hidden Shared (\nShared text\n)', '42': 'export Other (\nOther text\n)' },
};

function complete(text: string) {
  const state = EditorState.create({ doc: text });
  return clarityCompletions(globals)(new CompletionContext(state, text.length, true));
}

describe('shared parser symbols drive completion', () => {
  test.each([
    ['#da', '#damage'],
    ['var local = hello\n#lo', '#local'],
    ['<title More [De', 'Details'],
    ['import ', 'Shared'],
    ['import Shared from ', 'global'],
    ['import main from 4', '42'],
    ['<so', '<solar/>'],
  ])('%s offers %s', (text, label) => {
    expect(complete(text)?.options.map((option) => option.label)).toContain(label);
  });
  test('completion replaces only the active reference', () => {
    expect(complete('<title More [De')?.from).toBe('<title More ['.length);
    expect(complete('import main from 4')?.from).toBe('import main from '.length);
  });
});

test('table formatting is stable and preserves content and row flags', () => {
  const input = '< table background_1 >\n|b2 A | Long text\n| Z |c Q <background/>\n<$>';
  const formatted = formatMarkupTables(input);
  expect(formatted).toContain('|b2 A |  Long text');
  expect(formatted).toContain('<background/>');
  expect(formatMarkupTables(formatted)).toBe(formatted);
  expect(formatMarkupTables('Plain text')).toBe('Plain text');
});

test('legacy language keys map to native browser BCP-47 tags', () => {
  expect(markupLanguage('zh-chs')).toBe('zh-Hans');
  expect(markupLanguage('zh-cht')).toBe('zh-Hant');
  expect(markupLanguage('es-mx')).toBe('es-mx');
});

test('table formatting keeps the caret on its line and column and is one undoable change', async () => {
  const { history, undo } = await import('@codemirror/commands');
  const text = 'Heading\n< table wide >\n|b Label | Value\n| Long label | 2\n<$>\nFooter';
  let state = EditorState.create({
    doc: text,
    selection: { anchor: text.indexOf('Value') },
    extensions: history(),
  });
  const line = state.doc.lineAt(state.selection.main.head);
  const column = state.selection.main.head - line.from;
  state = state.update(tableFormattingTransaction(state) ?? {}).state;
  expect(state.doc.toString()).not.toBe(text);
  const nextLine = state.doc.lineAt(state.selection.main.head);
  expect(nextLine.number).toBe(line.number);
  expect(state.selection.main.head - nextLine.from).toBe(column);
  expect(
    undo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    }),
  ).toBe(true);
  expect(state.doc.toString()).toBe(text);
});

test('retired scoped syntax is no longer offered by completion', () => {
  for (const text of ['<wea', '<weapons Sn', '< weapon type (Sn', '</we']) {
    const labels = complete(text)?.options.map((option) => option.label) ?? [];
    expect(labels).not.toContain('<weapons');
    expect(labels).not.toContain('</weapons>');
    expect(labels).not.toContain('Sniper Rifle');
  }
});
