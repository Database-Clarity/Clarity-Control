import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markupLanguage, type MarkupGlobals } from '@clarity/core';
import { suggestContext, suggestItems } from './suggest/source';
import { coverMargins, editorScrollMargins } from './scrollMargins';

const globals: MarkupGlobals = {
  variables: 'var damage = 25\nvar duration = 10',
  titles: 'title Details (\nMore details\n)',
  imports: { '1': 'export hidden Shared (\nShared text\n)', '42': 'export Other (\nOther text\n)' },
};

function complete(text: string) {
  const state = EditorState.create({ doc: text, selection: { anchor: text.length } });
  const context = suggestContext(state, true);
  return context ? { from: context.from, options: suggestItems(context, state, globals) } : null;
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

test('legacy language keys map to native browser BCP-47 tags', () => {
  expect(markupLanguage('zh-chs')).toBe('zh-Hans');
  expect(markupLanguage('zh-cht')).toBe('zh-Hant');
  expect(markupLanguage('es-mx')).toBe('es-mx');
});

describe('editor scroll margins', () => {
  const scroller = { top: 100, bottom: 500, left: 0, right: 600 };
  test('keeps the caret clear of an overlay over the lower half, plus a gap', () => {
    const overlay = { top: 400, bottom: 500, left: 0, right: 600 };
    expect(coverMargins(scroller, [overlay])).toEqual({ top: 0, bottom: 108 });
    expect(coverMargins(scroller, [overlay], 0)).toEqual({ top: 0, bottom: 100 });
  });
  test('keeps the caret clear of a notice hanging over the top', () => {
    const notice = { top: 0, bottom: 130, left: 0, right: 600 };
    expect(coverMargins(scroller, [notice])).toEqual({ top: 38, bottom: 0 });
  });
  test('ignores anything that does not overlap the scroller', () => {
    expect(coverMargins(scroller, [{ top: 500, bottom: 524, left: 0, right: 600 }])).toEqual({
      top: 0,
      bottom: 0,
    });
    expect(coverMargins(scroller, [{ top: 400, bottom: 500, left: 700, right: 900 }])).toEqual({
      top: 0,
      bottom: 0,
    });
  });
  test('is a CodeMirror extension that can be added to a state', () => {
    const state = EditorState.create({ doc: 'x', extensions: editorScrollMargins() });
    expect(state.doc.toString()).toBe('x');
  });
});

test('retired scoped syntax is no longer offered by completion', () => {
  for (const text of ['<wea', '<weapons Sn', '< weapon type (Sn', '</we']) {
    const labels = complete(text)?.options.map((option) => option.label) ?? [];
    expect(labels).not.toContain('<weapons');
    expect(labels).not.toContain('</weapons>');
    expect(labels).not.toContain('Sniper Rifle');
  }
});
