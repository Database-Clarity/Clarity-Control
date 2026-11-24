import { expect, test } from 'vitest';
import {
  buildLegacy,
  compile,
  newStyleFile,
  provesInPlace,
  type LegacyInput,
} from '../src/index.js';
import { inPlaceCases, type InPlaceCase } from './fixtures/globals-inplace-cases.js';
import { inlineFixtureGlobals, readFixtureGlobals } from './globals-inplace-fixture.js';

const row = (hash: number, text: string, type: InPlaceCase['type'] = 'Weapon Trait') => ({
  hash,
  type,
  name: `Trait ${hash}`,
  editor: { en: { main: text, secondary: text } },
  uploadedBy: 'fixture',
  lastUpload: 1,
  updateTracker: { descriptions: {} },
  inLiveDatabase: true,
  uploadToLive: true,
});

const catalog = {
  items: { 100: { categoryId: 'perks' }, 200: { categoryId: 'perks' } },
  categories: [{ id: 'perks' }],
};
const file = newStyleFile('proof', 'structured', {
  categories: ['perks'],
  sandboxPerks: [],
  frameAliases: true,
  languages: ['en'],
  keys: ['name'],
  languageFiles: 'combined',
  bungieIdentical: true,
});

const fixture = (c: InPlaceCase): LegacyInput => ({
  perks: {
    1: row(1, c.x ?? ''),
    2: row(2, `${c.v ?? ''}\nvar e = 🡅`),
    3: row(3, c.t ?? ''),
    100: row(100, c.a, c.type),
    200: row(200, c.b ?? 'Other'),
  },
});

const capture = (render: () => Uint8Array) => {
  try {
    return Buffer.from(render()).toString('utf8');
  } catch (error) {
    return String(error);
  }
};
const render = (input: LegacyInput) => [
  capture(() => buildLegacy(input, 'clarity')),
  capture(() => buildLegacy(input, 'dim')),
  capture(() => buildLegacy(input, 'clarityV2')),
  capture(() => compile(input, file, { catalog }).bytes),
];

test.each(inPlaceCases)('$name is equal or refused before writing output', (c) => {
  const input = fixture(c);
  const definitions = readFixtureGlobals(input);
  const transformed = inlineFixtureGlobals(input, definitions);
  const refusals = provesInPlace(input, transformed);
  if (!refusals.length) {
    expect(render(transformed)).toEqual(render(input));
    expect(inlineFixtureGlobals(transformed, definitions)).toEqual(transformed);
  } else {
    expect(refusals[0].message).toContain("in a way that can't be published.");
  }
  if (c.name.startsWith('local-only')) {
    expect(refusals).toEqual([]);
    expect(transformed.perks[100]).toEqual(input.perks[100]);
  }
});

test('the proof checks the selected type and legacy secondary part', () => {
  const input = fixture({
    name: 'legacy secondary and catalyst',
    a: 'Visible text\ncatalyst (\nOnly the catalyst #N\n)',
    type: 'Weapon Catalyst Exotic',
    v: 'var N = 4.5',
  });
  const target = input.perks[100];
  if (!('editor' in target)) throw new Error('Expected a canonical row');
  target.editor.en!.secondary = 'Secondary #e#N';
  const candidate = inlineFixtureGlobals(input);
  expect(provesInPlace(input, candidate)).toEqual([
    expect.objectContaining({ hash: '100', language: 'en', part: 'secondary' }),
  ]);
});
