import { expect, test } from 'vitest';
import {
  exportLegacy,
  exportWithInactiveMoves,
  globalNoteImportInBlockMessage,
  globalsInPlaceMessages,
  ordinaryImportsInBlocks,
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
      'title Help (',
      'Base/enhanced {{4.5}{5.5}}. <solar Scorch />',
      ')',
    ].join('\n'),
  );
  expect(inline(result)).toBe(result);
  const untouched = 'var Nlocal = 6\r\n#Nlocal\r\nimport main from 100\r\n// #N  ';
  expect(inline(untouched)).toBe(untouched);
  expect(inline('A\r\nimport Second from global\r\nB')).toContain(' />\r\nB\ntitle Help');
  expect(inline('#N before #Name')).toBe('4.5 before Energy');
  expect(inline('var d = 2\n#{d}#{N}')).toBe('var d = 2\n#{d}4.5');
  expect(inline('#N // {{comment')).toBe('4.5 // {{comment');
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
    ['#e#N', m.generatedReference],
    ['var d = 2\n#d#{N}', m.generatedReference],
    ['#e#{Empty}x', m.generatedReference],
    ['var x = Help\n<title Read [#{x}] />', m.noteReference],
    ['var x = [Help] />\n<title Read #x', m.noteReference],
    ['var x = <title Read [Help] />\n#x', m.noteReference],
    ['<#{N} Scorch />', m.elementTag],
    ['#{Empty}import main from 100', m.generatedStructure],
    ['<title Read [Help] />\nenhanced (\nUnclosed', m.unclosedBlock],
    ['<title Read [Help] />\ntitle Local (\nUnclosed', m.unclosedBlock],
    ['<title Read [Help] />\nexport hidden Part (\nUnclosed', m.unclosedBlock],
    ['<title Read [Help] />\ntitle Help (\nA local title\n)', m.localNote],
    ['import main from 100\ntitle Help (\nA local title\n)', m.localNote],
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
  const variable = (body: string) => ({
    definitions: { variables: { N: { en: { body } } } },
  });
  expect(() => resolveGlobalsInPlace('<solar #N />', 'en', variable('<arrow/>'))).toThrow(
    m.elementTag,
  );
  expect(() => resolveGlobalsInPlace('#N (\nText\n)', 'en', variable('enhanced'))).toThrow(
    m.generatedStructure,
  );
  expect(() => resolveGlobalsInPlace('import main from #N', 'en', variable('100'))).toThrow(
    m.generatedStructure,
  );
});

const doc = (hash: number, text: string): Tooltip => {
  const base = tooltip();
  return { ...base, hash, text: { en: { ...base.text.en!, text } } };
};

test('legacy export retains the native markup guard for resolved global values and notes', () => {
  for (const text of ['<title Read [Help] />', '#Pair', '{#Open']) {
    const globalsInPlace = {
      definitions: {
        ...definitions,
        variables: {
          ...definitions.variables,
          Pair: { en: { body: '{{4}{6}}' } },
          Open: { en: { body: '{4}{6}}' } },
        },
      },
    };
    expect(() => exportLegacy([doc(100, text)], 0, undefined, {}, { globalsInPlace })).toThrow(
      'Tooltip 100 (en): Base/enhanced markup needs the new converter',
    );
  }
  expect(() =>
    exportLegacy(
      [doc(100, 'import Absent from global')],
      0,
      undefined,
      {},
      { globalsInPlace: options },
    ),
  ).toThrow('Tooltip 100 (en): Choose an existing named global export.');
});

test('lists block imports for the publisher without rejecting legitimate source', () => {
  const source = [
    'import main from 100',
    'enhanced (',
    'import  main  from 200',
    'import Name from 300',
    'import self',
    ')',
    'title Local (',
    'import secondary from 0400',
    ')',
    '/*\nexport hidden Part (\nimport main from 500\n)\n*/',
  ].join('\r\n');
  expect(ordinaryImportsInBlocks(source)).toEqual([
    { part: 'main', target: '200' },
    { part: 'self' },
    { part: 'secondary', target: '0400' },
  ]);
  expect(inline(source)).toBe(source);
  expect(globalNoteImportInBlockMessage('Alternate')).toBe(
    'Move the import of Alternate out of the block: it uses a shared note.',
  );
});

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
  const opts = {
    globalsInPlace: {
      definitions: { ...definitions, titles: { Help: { en: { body: 'Help' } } } },
    },
  };
  expect(() => exportWithInactiveMoves(source, 0, undefined, {}, moves, opts)).toThrow(
    'Tooltip 200 imports inactive tooltip 100',
  );
  expect(exportWithInactiveMoves(source, 0, undefined, {}, {}, opts)).toEqual(
    exportCanonical(source, 0, undefined, {}, opts),
  );
});
