// ELEMENT-TAGS-2 AC1, the export engine (legacy job and configured files): an input whose texts
// hold element-tagged spans (`<solar Scorch />`) builds byte for byte what its lowered form
// (`<solar/>Scorch`, today's format) builds, which the pinned hashes of the held converter fix.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { findElementTags } from '@clarity/core';
import {
  buildAllLegacy,
  buildLegacy,
  bungieIdentical,
  compile,
  legacyPresets,
  newStyleFile,
  styles,
  type Catalog,
  type LegacyInput,
} from '../src/index.js';
import { lowerInput } from '../src/elementTags.js';
import { loweredFixtures, raiseElementPairs } from '../../core/test/elementTagCorpus.js';
import { editorDataInput, expected, fixtureInput, sha256 } from './helpers.js';

type Texts = Record<string, { main: string; secondary: string } | undefined>;

/** The input with every element pair raised into a tag, in every language; the count raised. */
function raised(input: LegacyInput): { input: LegacyInput; count: number } {
  let count = 0;
  const perks = Object.fromEntries(
    Object.entries(input.perks).map(([hash, perk]) => {
      if (!('editor' in perk)) return [hash, perk];
      const editor = Object.fromEntries(
        Object.entries(perk.editor as Texts).map(([language, text]) => {
          if (!text) return [language, text];
          const main = raiseElementPairs(text.main);
          const secondary = raiseElementPairs(text.secondary);
          count += main.raised;
          return [language, { ...text, main: main.text, secondary: secondary.text }];
        }),
      );
      return [hash, { ...perk, editor }];
    }),
  );
  return { input: { ...input, perks } as LegacyInput, count };
}

const unlowered = /<(?:kinetic|arc|solar|void|stasis|strand) [^<>]*\/>/;
const decoder = new TextDecoder();

describe('legacy files from tagged input', () => {
  const editorData = editorDataInput();
  const fixture = fixtureInput();
  const tagged = raised(editorData.input);
  const taggedFixture = raised(fixture.input);

  test('the tagged inputs hold real tags in every kind of text', () => {
    expect(tagged.count).toBeGreaterThan(1000);
    expect(taggedFixture.count).toBeGreaterThan(0);
  });

  test.each(legacyPresets)(
    'editor data, %s: byte for byte the held converter (as for the untagged input)',
    (preset) => {
      const bytes = buildLegacy(tagged.input, preset, { identical: editorData.identical });
      expect(sha256(bytes)).toBe(expected.editorData.files[preset]);
      expect(decoder.decode(bytes)).not.toMatch(unlowered);
    },
    60_000,
  );

  test.each(legacyPresets)('fixture, %s: byte for byte the untagged fixture', (preset) => {
    const identical = bungieIdentical(fixture.input, fixture.inventoryItem as never);
    expect(sha256(buildLegacy(taggedFixture.input, preset, { identical }))).toBe(
      sha256(buildLegacy(fixture.input, preset, { identical })),
    );
  });

  test('Bungie-identical detection reads the lowered text', () => {
    const items = fixture.inventoryItem as never;
    expect(bungieIdentical(taggedFixture.input, items)).toEqual(
      bungieIdentical(fixture.input, items),
    );
  });

  // The small fixture keeps this fast (the full data set runs per preset above); it holds tags in
  // perks, enhanced text, titles, and tables.
  test('the legacy job path (buildAllLegacy) with clarityV2', () => {
    const versions = { descriptions: 2.0625 };
    const identical = bungieIdentical(fixture.input, fixture.inventoryItem as never);
    const options = { identical, presets: legacyPresets };
    const a = buildAllLegacy(taggedFixture.input, versions, options);
    const b = buildAllLegacy(fixture.input, versions, options);
    expect(a.files.map((file) => file.ok && sha256(file.bytes))).toEqual(
      b.files.map((file) => file.ok && sha256(file.bytes)),
    );
    for (const file of a.files)
      if (file.ok) expect(decoder.decode(file.bytes)).not.toMatch(unlowered);
  });
});

describe('configured files (custom-export compiler) from tagged input', () => {
  const realCatalog = JSON.parse(
    gunzipSync(
      readFileSync(new URL('./fixtures/catalog-c3fed8c.json.gz', import.meta.url)),
    ).toString('utf8'),
  ) as Catalog;
  const { input, identical } = editorDataInput();
  const tagged = raised(input).input;
  const file = (style: (typeof styles)[number]) =>
    newStyleFile('all', style, {
      categories: realCatalog.categories.map((c) => c.id),
      sandboxPerks: realCatalog.categories.map((c) => c.id),
      frameAliases: true,
      languages: ['en', 'de', 'fr', 'ja'],
      keys: ['name', 'associated'],
      bungieIdentical: false,
    });

  test.each(styles)(
    '%s: the same bytes as the lowered input',
    (style) => {
      const options = { catalog: realCatalog, identical };
      const bytes = compile(tagged, file(style), options).bytes;
      expect(sha256(bytes)).toBe(sha256(compile(input, file(style), options).bytes));
    },
    120_000,
  );

  test('a legacy preset through compile is the held converter file', () => {
    const plan = compile(
      tagged,
      { id: 'old', formatVersion: 1, preset: 'dim' },
      {
        catalog: realCatalog,
        identical,
      },
    );
    expect(sha256(plan.bytes)).toBe(expected.editorData.files.dim);
  });
});

describe('lowerInput', () => {
  test('untagged input comes back as the same object', () => {
    const { input } = editorDataInput();
    expect(lowerInput(input)).toBe(input);
  });

  test.each(loweredFixtures)(
    '%s: main and secondary lower to the hand-written form',
    (_, tagged, lowered) => {
      expect(findElementTags(tagged).length).toBeGreaterThan(0);
      const perk = { hash: 100, editor: { en: { main: tagged, secondary: tagged } } };
      const input = { perks: { 100: perk } } as unknown as LegacyInput;
      const out = lowerInput(input).perks[100] as unknown as { editor: Texts };
      expect(out.editor.en).toEqual({ main: lowered, secondary: lowered });
      // The caller's input is never changed.
      expect(perk.editor.en.main).toBe(tagged);
    },
  );
});
