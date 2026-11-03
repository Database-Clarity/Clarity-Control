import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { Lang, MarkupGlobals, Tooltip } from '@clarity/core';
import {
  isInComment,
  locateBlocks,
  locateVariables,
  referenceInLine,
  resolveReference,
  tooltipTextSources,
  type ResolveContext,
} from './references';
import { localTargetTransaction, referenceAtPosition } from './referenceActions';

function tooltip(hash: number, text: Partial<Record<Lang, string>>): Tooltip {
  return {
    hash,
    text: Object.fromEntries(
      Object.entries(text).map(([lang, value]) => [lang, { text: value, updatedAt: 'x' }]),
    ),
  } as unknown as Tooltip;
}

const store: Record<string, Tooltip> = {
  '2': tooltip(2, {
    en: 'var damage = 25\nvar empty1 = empty\nvar onlyEn = <blue>English</blue>',
    de: 'var damage = 30',
  }),
  '3': tooltip(3, {
    en: 'title Details (\nEnglish details\n)\n\ntitle OnlyEn (\nonly\n)',
    de: 'title Details (\nDeutsche Details\n)',
  }),
  '42': tooltip(42, {
    en: 'Main text\n\nexport Perk (\nPerk body\n)\n\nexport hidden Quiet (\nquiet\n)',
    de: 'Haupttext\n\nexport Perk (\nPerk Körper\n)',
  }),
};
const sources = tooltipTextSources(store, {}, {});

function context(doc: string, lang: Lang, selfHash?: number): ResolveContext {
  const text = (hash: number) => store[hash]?.text[lang]?.text ?? '';
  const globals: MarkupGlobals = {
    variables: text(2),
    titles: text(3),
    imports: { '2': text(2), '3': text(3), '42': text(42) },
  };
  return { doc, lang, globals, sources, selfHash };
}

function resolveAt(line: string, column: number, ctx: ResolveContext) {
  const ref = referenceInLine(line, column);
  if (!ref) throw new Error(`no reference at ${column} in ${line}`);
  return resolveReference(ref, ctx);
}

describe('reference tokens', () => {
  test('finds variables, title names and import lines, edges included', () => {
    expect(referenceInLine('Deal #damage now', 7)).toMatchObject({
      kind: 'variable',
      name: 'damage',
      from: 5,
      to: 12,
    });
    expect(referenceInLine('Deal #damage now', 12)).toMatchObject({ name: 'damage' });
    expect(referenceInLine('Deal #damage now', 4)).toBeNull();
    const title = '<title See [Details] />';
    expect(referenceInLine(title, title.indexOf('Details') + 2)).toMatchObject({
      kind: 'title',
      name: 'Details',
      from: title.indexOf('Details'),
      to: title.indexOf('Details') + 'Details'.length,
    });
    expect(referenceInLine(title, 2)).toBeNull();
    expect(referenceInLine('import Perk from 42', 8)).toMatchObject({
      kind: 'import',
      name: 'Perk',
      source: '42',
    });
    expect(referenceInLine('import self', 8)).toBeNull();
    expect(referenceInLine('import Perk from global', 3)).toBeNull();
  });
  test('comments are not references', () => {
    const doc = '// #damage\n/* #damage\n#damage */\n#damage';
    expect(isInComment(doc, 3, 10)).toBe(true);
    expect(isInComment(doc, 15, 22)).toBe(true);
    expect(isInComment(doc, doc.lastIndexOf('#damage'), doc.length)).toBe(false);
    const state = EditorState.create({ doc });
    expect(referenceAtPosition(state.doc, 5)).toBeNull();
    expect(referenceAtPosition(state.doc, doc.length - 2)).toMatchObject({ name: 'damage' });
  });
  test('locators agree with the parser syntax helpers', () => {
    expect([...locateVariables('x\nvar a = 1\nvar b = empty\nvar a = 2').values()]).toMatchObject([
      { name: 'a', value: '2', line: 4 },
      { name: 'b', value: '', line: 3 },
    ]);
    const blocks = locateBlocks('x\nexport hidden Foo bar (\nBody\nmore\n)', 'export');
    expect(blocks.get('Foo bar')).toMatchObject({ value: 'Body\nmore', line: 2 });
  });
});

describe('variables', () => {
  test('a local var resolves in the open document and targets its name', () => {
    const doc = 'intro\nvar mine = <blue>mine</blue>\nUse #mine';
    const resolved = resolveAt('Use #mine', 6, context(doc, 'en'));
    expect(resolved).toMatchObject({ status: 'found', scope: 'local', value: '<blue>mine</blue>' });
    const from = doc.indexOf('mine =');
    expect(resolved.target).toEqual({ type: 'local', from, to: from + 4 });
  });
  test('a global var resolves to the Variables tooltip line', () => {
    const resolved = resolveAt('#onlyEn', 3, context('#onlyEn', 'en'));
    expect(resolved).toMatchObject({ scope: 'global', hash: 2, lang: 'en' });
    expect(resolved.target).toEqual({ type: 'tooltip', hash: 2, lang: 'en', line: 3 });
  });
  test('the global wins over a same-named local, as the exporter merges them', () => {
    const resolved = resolveAt('#damage', 2, context('var damage = 1\n#damage', 'en'));
    expect(resolved).toMatchObject({ scope: 'global', value: '25' });
    expect(resolved.note).toMatch(/Error: also defined in this tooltip/);
  });
  test('an empty variable is found with an empty value', () => {
    expect(resolveAt('#empty1', 2, context('#empty1', 'en'))).toMatchObject({
      status: 'found',
      value: '',
    });
  });
  test('the current language wins; a missing translation falls back to English', () => {
    expect(resolveAt('#damage', 2, context('#damage', 'de'))).toMatchObject({
      value: '30',
      lang: 'de',
    });
    const fallback = resolveAt('#onlyEn', 2, context('#onlyEn', 'de'));
    expect(fallback).toMatchObject({ status: 'found', fallback: true, lang: 'en' });
    expect(fallback.target).toEqual({ type: 'tooltip', hash: 2, lang: 'en', line: 3 });
  });
  test('undefined variables are reported as missing, with no target', () => {
    const resolved = resolveAt('#nope', 2, context('#nope', 'en'));
    expect(resolved).toMatchObject({ status: 'missing' });
    expect(resolved.reason).toMatch(/No variable "nope"/);
    expect(resolved.target).toBeUndefined();
  });
  test('editing the Variables tooltip itself selects in place instead of navigating', () => {
    const doc = store['2'].text.en!.text;
    const resolved = resolveAt('#damage', 2, context(doc, 'en', 2));
    const from = doc.indexOf('damage');
    expect(resolved.target).toEqual({ type: 'local', from, to: from + 'damage'.length });
    expect(resolveAt('#damage', 2, context(doc, 'en', 5)).target?.type).toBe('tooltip');
  });
});

describe('titles', () => {
  const line = '<title see [Details] />';
  const column = line.indexOf('Details') + 1;
  test('global title, in language and via English fallback', () => {
    expect(resolveAt(line, column, context(line, 'de'))).toMatchObject({
      scope: 'global',
      hash: 3,
      value: 'Deutsche Details',
    });
    const only = '<title see [OnlyEn] />';
    const fallback = resolveAt(only, only.indexOf('OnlyEn'), context(only, 'de'));
    expect(fallback).toMatchObject({ fallback: true, lang: 'en', value: 'only' });
    expect(fallback.target).toEqual({ type: 'tooltip', hash: 3, lang: 'en', line: 5 });
  });
  test('local title block targets its header; missing title is reported', () => {
    const doc = 'text\ntitle Mine (\nbody\n)\n<title x [Mine] />';
    const local = resolveAt('<title x [Mine] />', 12, context(doc, 'en'));
    expect(local).toMatchObject({ scope: 'local', value: 'body' });
    expect(local.target).toEqual({
      type: 'local',
      from: doc.indexOf('Mine ('),
      to: doc.indexOf('Mine (') + 4,
    });
    expect(resolveAt('<title x [Gone] />', 12, context('<title x [Gone] />', 'en'))).toMatchObject({
      status: 'missing',
    });
  });
});

describe('imports', () => {
  test('exports resolve to the defining tooltip, language and line', () => {
    const resolved = resolveAt('import Perk from 42', 9, context('import Perk from 42', 'en'));
    expect(resolved).toMatchObject({ status: 'found', value: 'Perk body', hash: 42 });
    expect(resolved.target).toEqual({ type: 'tooltip', hash: 42, lang: 'en', line: 3 });
    const hidden = resolveAt('import Quiet from 42', 9, context('import Quiet from 42', 'en'));
    expect(hidden).toMatchObject({ value: 'quiet' });
    expect(hidden.target).toMatchObject({ line: 7 });
  });
  test('main imports the whole text and opens at line 1', () => {
    const resolved = resolveAt('import main from 42', 9, context('import main from 42', 'de'));
    expect(resolved).toMatchObject({
      whole: true,
      value: 'Haupttext\n\nexport Perk (\nPerk Körper\n)',
    });
    expect(resolved.target).toEqual({ type: 'tooltip', hash: 42, lang: 'de', line: 1 });
  });
  test('English fallback when the export is missing in this language', () => {
    const resolved = resolveAt('import Quiet from 42', 9, context('import Quiet from 42', 'de'));
    expect(resolved).toMatchObject({ fallback: true, lang: 'en', value: 'quiet' });
    expect(resolved.target).toMatchObject({ hash: 42, lang: 'en' });
  });
  test('unknown export or tooltip is missing and cannot be opened', () => {
    const noExport = resolveAt('import Nope from 42', 9, context('import Nope from 42', 'en'));
    expect(noExport.status).toBe('missing');
    expect(noExport.reason).toMatch(/no export "Nope"/);
    const noTooltip = resolveAt('import Perk from 999', 9, context('import Perk from 999', 'en'));
    expect(noTooltip).toMatchObject({ status: 'missing' });
    expect(noTooltip.target).toBeUndefined();
  });
  test('aliases land on the canonical tooltip', () => {
    const aliased = tooltipTextSources(store, {}, { 77: { to: 42, kind: 'sandbox' } });
    expect(aliased.textFor(77, 'en')?.hash).toBe(42);
  });
  test('drafts win over the saved text', () => {
    const drafted = tooltipTextSources(
      store,
      { '42': { next: tooltip(42, { en: 'export Perk (\ndraft body\n)' }) } },
      {},
    );
    const resolved = resolveReference(
      { kind: 'import', name: 'Perk', source: '42', from: 7, to: 19 },
      {
        ...context('import Perk from 42', 'en'),
        globals: { variables: '', titles: '' },
        sources: drafted,
      },
    );
    expect(resolved).toMatchObject({ value: 'draft body' });
  });
});

describe('go to definition', () => {
  test('a local jump selects the definition and never changes the text', () => {
    const doc = 'var mine = 1\n\n\n\n#mine';
    const resolved = resolveAt('#mine', 2, context(doc, 'en'));
    if (resolved.target?.type !== 'local') throw new Error('expected a local target');
    const state = EditorState.create({ doc, selection: { anchor: doc.length } });
    const next = state.update(localTargetTransaction(resolved.target)).state;
    expect(next.doc.toString()).toBe(doc);
    expect(next.selection.main.from).toBe(4);
    expect(next.selection.main.to).toBe(8);
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('mine');
  });
  test('the caret on a token edge still finds the reference (F12 from a typed token)', () => {
    const state = EditorState.create({ doc: 'Hit #damage' });
    expect(referenceAtPosition(state.doc, state.doc.length)).toMatchObject({
      name: 'damage',
      range: { from: 4, to: 11 },
    });
    expect(referenceAtPosition(state.doc, 3)).toBeNull();
  });
});
