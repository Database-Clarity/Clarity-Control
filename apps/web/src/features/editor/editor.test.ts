import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markupLanguage, markupWeaponTypes, validateText, type MarkupGlobals } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { clarityCompletions } from './completion';
import { clarityLanguage } from './language';
import { planWeaponSyntaxConversion, weaponSyntaxConversion } from './weaponSyntax';
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
    ['< weapon type (Sn', 'Sniper Rifle'],
    ['<weapons Sn', 'Sniper Rifle'],
    ['<weapons Sword, Ha', 'Hand Cannon'],
    ['<weapons Sword, ot', 'other'],
    ['<wea', '<weapons'],
    ['</we', '</weapons>'],
  ])('%s offers %s', (text, label) => {
    expect(complete(text)?.options.map((option) => option.label)).toContain(label);
  });
  test('weapon-type completion replaces only the name being typed', () => {
    const text = '<weapons Sword, Hand Ca';
    expect(complete(text)?.from).toBe('<weapons Sword, '.length);
    expect(complete('<weapons Su')?.from).toBe('<weapons '.length);
    expect(complete('Text <weapons Sn')?.options.map((option) => option.label)).not.toContain(
      'Sniper Rifle',
    );
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

describe('weapon-type syntax in the editor', () => {
  test('the language highlights open and close tags as markup', () => {
    const state = EditorState.create({
      doc: '<weapons Sword, Hand Cannon>\nText\n</weapons>\n<WEAPONS other>',
      extensions: clarityLanguage,
    });
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === 'typeName') names.push(state.sliceDoc(node.from, node.to));
      },
    });
    expect(names).toEqual(['<weapons Sword, Hand Cannon>', '</weapons>', '<WEAPONS other>']);
  });

  test('conversion is one undoable change that keeps the caret and the surrounding text', async () => {
    const { history, undo } = await import('@codemirror/commands');
    const text = 'Intro\n< weapon type (Bow, HC) >\nBows\n< (other) >\nRest\n<$$>\nOutro';
    let state = EditorState.create({
      doc: text,
      selection: { anchor: text.indexOf('Outro') + 2 },
      extensions: history(),
    });
    const conversion = weaponSyntaxConversion(state);
    expect(conversion).toBeDefined();
    state = state.update(conversion ?? {}).state;
    expect(state.doc.toString()).toBe(
      [
        'Intro',
        '<weapons Combat Bow, Hand Cannon>',
        'Bows',
        '</weapons>',
        '<weapons other>',
        'Rest',
        '</weapons>',
        'Outro',
      ].join('\n'),
    );
    expect(state.sliceDoc(state.selection.main.head - 2, state.selection.main.head + 3)).toBe(
      'Outro',
    );
    expect(weaponSyntaxConversion(state)).toBeUndefined();
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

  test('a conversion that would lose text changes nothing and says why', () => {
    const allTypes = `< weapon type ( ${markupWeaponTypes.join(', ')} ) >`;
    const chain = (note: string) => [allTypes, 'All types', '< ( other ) >', note, '<$$>'];
    const text = [...chain('Authored note A'), ...chain('Authored note B')].join('\n');
    const state = EditorState.create({ doc: text });
    const plan = planWeaponSyntaxConversion(state);
    expect(plan.change).toBeUndefined();
    expect(plan.diagnostic).toMatch(/fallback with no remaining types/i);
    expect(weaponSyntaxConversion(state)).toBeUndefined();
    expect(planWeaponSyntaxConversion(EditorState.create({ doc: 'Plain text' }))).toEqual({});
  });

  test.each(['// #open', '/* #open */'])(
    'a variable inside %s refuses conversion without an editor change',
    (comment) => {
      const text = `<weapons other>\n</weapons>\n${comment}\n< weapon type ( Sword ) >\nOld sword\n/* close */\n< ( other ) >\nOld fallback\n<$$>`;
      const state = EditorState.create({
        doc: text,
        selection: { anchor: text.indexOf('Old fallback') },
      });
      const plan = planWeaponSyntaxConversion(state);
      expect(plan.change).toBeUndefined();
      expect(plan.diagnostic).toMatch(/variable.*cannot be safely verified/);
      expect(weaponSyntaxConversion(state)).toBeUndefined();
      expect(state.doc.toString()).toBe(text);
      expect(state.selection.main.head).toBe(text.indexOf('Old fallback'));
    },
  );

  test('the old-syntax warning and conversion button appear only for editable old text', () => {
    const props = { lang: 'en' as const, globals, onChange: () => undefined };
    const old = '< weapon type (HC) >\nx\n<$$>';
    const markup = (value: string, readOnly = false) =>
      renderToStaticMarkup(createElement(ClarityEditor, { ...props, value, readOnly }));
    expect(markup(old)).toContain('<button type="button">Convert old weapon-type syntax</button>');
    expect(markup(old, true)).not.toContain('<button');
    expect(markup('<weapons Hand Cannon>\nx\n</weapons>')).not.toContain('Convert old');
    expect(validateText(old, 'en', globals).map((issue) => issue.message)).toEqual([
      expect.stringMatching(/Old weapon-type syntax/),
    ]);
  });
});
