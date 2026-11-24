import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { exportLegacy, type Tooltip } from '@clarity/core';
import {
  buildLegacy,
  bungieIdentical,
  compile,
  newStyleFile,
  type Catalog,
  type LegacyInput,
} from '../src/index.js';
import { inlineFixtureGlobals, readFixtureGlobals } from './globals-inplace-fixture.js';
import { editorDataInput, expected, sha256 } from './helpers.js';

const file = (language: 'en' | 'de') =>
  newStyleFile('globals', 'structured', {
    categories: ['perks'],
    sandboxPerks: [],
    frameAliases: true,
    languages: [language],
    keys: ['name'],
    languageFiles: 'combined',
    bungieIdentical: true,
  });

test('checked-in editor data keeps held legacy bytes and format v2 bytes', () => {
  const { input, identical } = editorDataInput();
  const resolved = inlineFixtureGlobals(input);
  expect(sha256(buildLegacy(resolved, 'clarity', { identical }))).toBe(
    expected.editorData.files.clarity,
  );
  const catalog = JSON.parse(
    gunzipSync(
      readFileSync(new URL('./fixtures/catalog-c3fed8c.json.gz', import.meta.url)),
    ).toString(),
  ) as Catalog;
  const config = file('en');
  config.data.categories = catalog.categories.map(({ id }) => id);
  const render = (data: LegacyInput) => sha256(compile(data, config, { catalog, identical }).bytes);
  expect(render(resolved)).toBe(render(input));
}, 60_000);

test('named global exports, title maths, German numbers, and aliases render with the existing readers', () => {
  const common = { updatedAt: '2026-11-24T00:00:00Z', updatedBy: 'fixture' };
  const text = [
    'import First from global',
    'Number 6.5. #Name before #N! #{Empty}word.',
    '<title Read [Help] /> <link Docs [#URL] />',
  ].join('\n');
  const doc = (hash: number, en: string, de = en): Tooltip => ({
    hash,
    associated: [],
    text: { en: { ...common, text: en }, de: { ...common, text: de } },
  });
  const docs = [
    doc(
      1,
      'export First (\nimport Second from global\n)\nexport Second (\nTest <title Read [Help] />\n)',
    ),
    doc(2, 'var Name = Energy\nvar N = 4.5\nvar URL = https://example.com\nvar Empty = empty'),
    doc(3, 'title Help (\n<solar Scorch /> does ${#N+0.5} damage.\n)'),
    doc(100, text, text.replace('Number 6.5', 'Zahl #{=1}')),
    doc(200, 'Same Bungie text'),
  ];
  const facts = Object.fromEntries(
    [1, 2, 3, 100, 200, 201].map((hash) => [hash, { name: 'Test', type: 'Weapon Trait' }]),
  );
  const aliases = { 201: { to: 100, kind: 'frame' as const } };
  const exportInput = (options?: Parameters<typeof exportLegacy>[4]) =>
    JSON.parse(
      JSON.stringify({ perks: exportLegacy(docs, 0, facts, aliases, options) }),
    ) as LegacyInput;
  const original = exportInput();
  const resolved = exportInput({ globalsInPlace: { definitions: readFixtureGlobals(original) } });
  const inventory = {
    100: { displayProperties: { description: 'From Bungie' } },
    200: { displayProperties: { description: 'Same Bungie text' } },
    201: { displayProperties: { description: 'Other Bungie text' } },
  };
  const identical = bungieIdentical(original, inventory);
  expect(identical).toEqual(['200']);
  expect(bungieIdentical(resolved, inventory)).toEqual(identical);
  const legacy = (value: LegacyInput) => Buffer.from(buildLegacy(value, 'clarity', { identical }));
  expect(legacy(resolved).equals(legacy(original))).toBe(true);
  const catalog = {
    items: {
      100: { categoryId: 'perks' },
      200: { categoryId: 'perks' },
      201: { categoryId: 'perks' },
    },
    categories: [{ id: 'perks' }],
  };
  const v2 = (value: LegacyInput) => compile(value, file('de'), { catalog, identical });
  expect(Buffer.from(v2(resolved).bytes).equals(Buffer.from(v2(original).bytes))).toBe(true);
  expect(JSON.stringify(v2(resolved).expanded?.[100]?.descriptions.de)).toContain('6,5');
});

test('a global note and its caller keep native base and enhanced pairs', () => {
  const perk = (hash: number, main: string) => ({
    hash,
    name: `Trait ${hash}`,
    type: 'Weapon Trait' as const,
    editor: { en: { main, secondary: main } },
    uploadedBy: 'fixture',
    lastUpload: 1,
    updateTracker: { descriptions: {} },
    inLiveDatabase: true,
    uploadToLive: true,
  });
  const input: LegacyInput = {
    perks: {
      1: perk(1, ''),
      2: perk(2, 'var N = 4\nvar e = 🡅'),
      3: perk(3, 'title Help (\n<solar Scorch /> for {{#N}{6}} seconds\n)'),
      100: perk(100, 'Duration {{#N}{6}}. <title Read [Help] />'),
      101: {
        hash: 101,
        aliasOf: 100,
        aliasKind: 'frame',
        name: 'Enhanced',
        type: 'Weapon Trait Enhanced',
      },
    },
  };
  const resolved = inlineFixtureGlobals(input);
  const catalog = {
    items: { 100: { categoryId: 'perks' }, 101: { categoryId: 'perks' } },
    categories: [{ id: 'perks' }],
  };
  const render = (data: LegacyInput) => [
    Buffer.from(buildLegacy(data, 'clarityV2')),
    Buffer.from(compile(data, file('en'), { catalog }).bytes),
  ];
  const outputs = render(resolved);
  expect(outputs).toEqual(render(input));
  expect(outputs[0].toString()).toContain('6');
  expect(outputs[1].toString()).toContain('Scorch');
});
