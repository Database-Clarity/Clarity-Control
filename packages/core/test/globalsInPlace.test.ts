import { expect, test } from 'vitest';
import {
  exportLegacy,
  exportWithInactiveMoves,
  globalsInPlaceMessages,
  publishableHash,
  resolveGlobalsInPlace,
  validateGlobalsInPlaceDefinition,
  validateGlobalsInPlaceSource,
  type GlobalsInPlaceOptions,
  type Tooltip,
} from '../src/index.js';
import { exportCanonical, tooltip } from './helpers.js';

const definitions = {
  variables: {
    N: { en: { body: '4.5', updatedAt: '2026-11-24T00:00:00Z' }, de: { body: '2.5' } },
    Name: { en: { body: 'Energy' } },
    URL: { en: { body: 'https://example.com/x' } },
    Empty: { en: { body: 'empty' } },
  },
  titles: {
    Help: { en: { body: 'Base/enhanced {{#N}{5.5}}. <solar Scorch />' } },
  },
  exports: {
    First: { en: { body: 'import Second from global\nimport main from 100' } },
    Second: { en: { body: 'Result ${1+#N}. <title Read [Help] />' } },
  },
} satisfies GlobalsInPlaceOptions['definitions'];
const options = { definitions };
const inline = (text: string) => resolveGlobalsInPlace(text, 'en', options);

test('inlines exact variables, notes and nested named imports per cell', () => {
  const text = [
    '#Name: #N, #{N}x; #{Empty}ok; #e.',
    '<link Data [#URL] /> <link Fragment [https://example.org/#Name] />',
    '<title Read #N [Help] />',
    '// Keep this comment #Name',
    'import First from global',
  ].join('\n');
  const result = inline(text);
  expect(result).toBe(
    [
      'Energy: 4.5, 4.5x; ok; #e.',
      '<link Data [https://example.com/x] /> <link Fragment [https://example.org/Energy] />',
      '<title Read 4.5 [Help] />',
      '// Keep this comment #Name',
      'Result ${1+4.5}. <title Read [Help] />',
      'import main from 100',
      '',
      'title Help (',
      'Base/enhanced {{4.5}{5.5}}. <solar Scorch />',
      ')',
    ].join('\n'),
  );
  expect(inline(result)).toBe(result);
  const untouched = 'var Nlocal = 6\r\n#Nlocal\r\nimport main from 100\r\n// #N  ';
  expect(inline(untouched)).toBe(untouched);
  expect(inline('A\r\nimport Second from global\r\nB')).toContain(' />\r\nB\n\ntitle Help');
});

test('uses the destination language and applies the configured missing/stale global policy', () => {
  const globals = structuredClone(options) as GlobalsInPlaceOptions;
  const translation = globals.definitions.variables!.N!.de!;
  const read = (policy?: GlobalsInPlaceOptions['missingTranslation']) =>
    resolveGlobalsInPlace('#N', 'de', { ...globals, missingTranslation: policy });
  translation.sourceUpdatedAt = '2026-08-26T00:00:00Z'; // exactly 90 days before English
  expect(read('reject')).toBe('2.5');
  translation.sourceUpdatedAt = '2026-08-25T23:59:59Z';
  expect(read()).toBe('4.5');
  expect(() => read('reject')).toThrow(globalsInPlaceMessages.missingTranslation);
  expect(resolveGlobalsInPlace('#Name', 'de', globals)).toBe('Energy');
  expect(() =>
    resolveGlobalsInPlace('#Name', 'de', { ...globals, missingTranslation: 'reject' }),
  ).toThrow(globalsInPlaceMessages.missingTranslation);
});

test('lists unsupported source and definition forms with actionable messages', () => {
  const m = globalsInPlaceMessages;
  const sourceCases = [
    ['import main from 0002', m.aggregateImport],
    ['import First from 1', m.aggregateImport],
    ['import secondary from global', m.wholeGlobalImport],
    ['export hidden Part (\n<title Read [Help] />\n)', m.noteInExport],
    ['export Part (\nimport Second from global\n)', m.noteInExport],
    ['/*\nimport First from global\n*/', m.commentedImport],
    ['import Absent from global', m.missingExport],
    ['{{#Empty}{2}}', m.nativePair],
    ['##{Empty}N', m.generatedReference],
    ['<title Read [Help] />\ntitle Help (\nA local title\n)', m.localNote],
  ] as const;
  for (const [source, message] of sourceCases)
    expect(validateGlobalsInPlaceSource(source, 'en', options)).toEqual(
      expect.arrayContaining([expect.stringContaining(message)]),
    );
  expect(() =>
    resolveGlobalsInPlace('import Loop from global', 'en', {
      definitions: { exports: { Loop: { en: { body: 'import Loop from global' } } } },
    }),
  ).toThrow(m.cyclicExport);
  const definitionCases = [
    ['titles', '#{=1}', m.numberToken],
    ['variables', '#N', m.variableBody],
    ['titles', 'enhanced (\nText\n)', m.nestedBlock],
    ['exports', 'var local = 1', m.nestedBlock],
    ['titles', '<title Read [Other] />', m.noteBody],
    ['titles', 'import main from 100', m.noteBody],
    ['titles', 'Read #local', m.localVariable],
  ] as const;
  for (const [kind, body, message] of definitionCases)
    expect(validateGlobalsInPlaceDefinition(kind, body, definitions)).toContain(message);
});

const doc = (hash: number, text: string): Tooltip => {
  const base = tooltip();
  return { ...base, hash, text: { en: { ...base.text.en!, text } } };
};

test('opt-in preserves metadata, aliases and authored hashes and runs after number selection', async () => {
  const reader = doc(100, 'Duration 6.5 seconds. Value #N.');
  reader.text.de = { ...reader.text.en!, text: 'Dauer #{=1} Sekunden. Wert #N.' };
  reader.text.fr = { ...reader.text.en!, text: 'Ancien', sourceUpdatedAt: '2025-01-01T00:00:00Z' };
  reader.text.en!.updatedAt = '2026-11-24T00:00:00Z';
  const source = [doc(1, 'export Foo (\nSnippet\n)'), doc(2, 'var N = 4.5'), doc(3, ''), reader];
  const aliases = { 101: { to: 100, kind: 'sandbox' as const } };
  const before = exportLegacy(source, 0, undefined, aliases);
  const hash = await publishableHash(reader, aliases);
  const result = exportLegacy(source, 0, undefined, aliases, { globalsInPlace: options });
  const row = result[100];
  if (!('editor' in row)) throw new Error('Expected canonical tooltip');
  expect(row.editor.de).toEqual({
    main: 'Dauer 6.5 Sekunden. Wert 2.5.',
    secondary: 'Dauer 6.5 Sekunden. Wert 2.5.',
  });
  expect(row.editor.fr).toMatchObject({
    main: 'Duration 6.5 seconds. Value 4.5.',
    englishFallback: true,
  });
  expect(result[1]).toMatchObject({ editor: {} });
  expect(result[2]).toMatchObject({ editor: { en: { main: 'var e = 🡅', secondary: '' } } });
  expect(result[3]).toMatchObject({ editor: {} });
  expect(result[101]).toEqual(before[101]);
  expect(JSON.stringify(exportLegacy(source, 0, undefined, aliases, {}))).toBe(
    JSON.stringify(before),
  );
  expect(await publishableHash(reader, aliases)).toBe(hash);
});

test('inactive move checks include ordinary imports introduced by named globals', () => {
  const keep = doc(200, 'Text\nimport First from global');
  const moved = doc(100, 'Move out');
  const source = [keep, moved];
  const moves = { 100: { by: 1, at: '2026-11-24T00:00:00Z' } };
  expect(exportWithInactiveMoves(source, 0, undefined, {}, moves)).toEqual(exportLegacy([keep], 0));
  const opts = { globalsInPlace: options };
  expect(() => exportWithInactiveMoves(source, 0, undefined, {}, moves, opts)).toThrow(
    'Tooltip 200 imports inactive tooltip 100',
  );
  expect(exportWithInactiveMoves(source, 0, undefined, {}, {}, opts)).toEqual(
    exportCanonical(source, 0, undefined, {}, opts),
  );
});
