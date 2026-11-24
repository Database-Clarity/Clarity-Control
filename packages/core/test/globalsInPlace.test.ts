import { expect, test } from 'vitest';
import {
  exportLegacy,
  exportWithInactiveMoves,
  MissingGlobalTranslation,
  publishableHash,
  resolveGlobalsInPlace,
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
      'title Help (',
      'Base/enhanced {{4.5}{5.5}}. <solar Scorch />',
      ')',
      'Energy: 4.5, 4.5x; ok; #e.',
      '<link Data [https://example.com/x] /> <link Fragment [https://example.org/Energy] />',
      '<title Read 4.5 [Help] />',
      '// Keep this comment #Name',
      'Result ${1+4.5}. <title Read [Help] />',
      'import main from 100',
    ].join('\n'),
  );
  expect(inline(result)).toBe(result);
  const untouched = 'var Nlocal = 6\r\n#Nlocal\r\nimport main from 100\r\n// #Nlocal  ';
  expect(inline(untouched)).toBe(untouched);
  expect(inline('A\r\nimport Second from global\r\nB')).toContain(' />\r\nB');
  expect(inline('#N before #Name')).toBe('4.5 before Energy');
  expect(inline('var d = 2\n#{d}#{N}')).toBe('var d = 2\n#{d}4.5');
  expect(inline('#N // {{comment')).toBe('4.5 // {{comment');
});

test('reports missing and stale shared definitions to the tooltip exporter', () => {
  const globals = structuredClone(options) as GlobalsInPlaceOptions;
  const translation = globals.definitions.variables!.N!.de!;
  const read = () => resolveGlobalsInPlace('#N', 'de', globals);
  translation.sourceUpdatedAt = '2026-08-26T00:00:00Z'; // exactly 90 days before English
  expect(read()).toBe('2.5');
  translation.sourceUpdatedAt = '2026-08-25T23:59:59Z';
  expect(read).toThrow(MissingGlobalTranslation);
  expect(read).toThrow('Add or update the translation for shared N.');
  expect(() => resolveGlobalsInPlace('#Name', 'de', globals)).toThrow(
    'Add or update the translation for shared Name.',
  );
});

test('checks pending names in the authored source before expanding published bodies', () => {
  const globals = {
    definitions: {
      titles: { Help: { en: { body: 'Value #Pending' } } },
      exports: {
        First: { en: { body: 'import Second from global' } },
        Second: { en: { body: 'Nested #Pending. <title Read [PendingNote] />' } },
      },
    },
    unavailable: {
      variables: new Set(['Pending']),
      titles: new Set(['PendingNote']),
      exports: new Set(['PendingExport']),
    },
  };
  const resolve = (text: string) => resolveGlobalsInPlace(text, 'en', globals);
  expect(resolve('<title Read [Help] />')).toBe(
    'title Help (\nValue #Pending\n)\n<title Read [Help] />',
  );
  expect(resolve('import First from global')).toBe('Nested #Pending. <title Read [PendingNote] />');
  for (const [text, name] of [
    ['#Pending\nimport First from global', 'Pending'],
    ['<title Read [PendingNote] />\nimport First from global', 'PendingNote'],
    ['import PendingExport from global', 'PendingExport'],
  ])
    expect(() => resolve(text)).toThrow(`Publish the shared change for ${name} first.`);
  expect(resolve('title PendingNote (\nLocal\n)\n<title Read [PendingNote] />')).toContain('Local');
  expect(resolve('/* #Pending */\nimport First from global')).toContain('Nested #Pending');
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
  ).toThrow('Tooltip 100 (en): Choose an existing shared export for Absent.');
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
