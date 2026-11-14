// ELEMENT-TAGS-2 AC1, core exportLegacy (used by the Worker's push-live and bundled into the
// publisher): element-tagged text exports byte for byte as its hand-written lowered form.
import { expect, test } from 'vitest';
import { exportLegacy } from '../src/exportLegacy.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { findElementTags } from '../src/markup/elementTags.js';
import type { LegacyCatalog, LegacyPerk } from '../src/legacy.js';
import type { Tooltip } from '../src/schemas.js';
import { database, tooltip } from './helpers.js';
import { loweredFixtures, raiseTooltips } from './elementTagCorpus.js';

const unlowered = (value: unknown) =>
  JSON.stringify(value).match(
    /<(?:kinetic|arc|solar|void|stasis|strand|prismatic) [^<>]*\/>|[\uE000\uE001]/,
  );

function catalog(perks: Record<string, LegacyPerk>): LegacyCatalog {
  return Object.fromEntries(
    Object.entries(perks).map(([hash, perk]) => [hash, { name: perk.name, type: perk.type }]),
  );
}

test('real data: every existing pair raised to a tag exports byte for byte as today', () => {
  const live = database('live');
  const original = migrateLegacy(live);
  const { tooltips, raised } = raiseTooltips(original);
  // Real pairs in titles, imports, exports, enhanced sections, tables, and every language.
  expect(raised).toBeGreaterThan(1000);
  const facts = catalog(live.perks);
  const expected = JSON.stringify(exportLegacy(original, 0, facts));
  const actual = JSON.stringify(exportLegacy(tooltips, 0, facts));
  expect(actual).toBe(expected);
  expect(unlowered(actual)).toBeNull();
});

test.each(loweredFixtures)(
  '%s: exports exactly the hand-written lowered form',
  (_, tagged, lowered) => {
    expect(findElementTags(tagged).length).toBeGreaterThan(0);
    const base = tooltip();
    const make = (text: string): Tooltip => ({
      ...base,
      text: {
        en: { ...base.text.en!, text },
        de: { ...base.text.en!, text: `de ${text}` },
      },
    });
    const [entry] = Object.values(exportLegacy([make(tagged)], 0));
    const [expected] = Object.values(exportLegacy([make(lowered)], 0));
    expect(JSON.stringify(entry)).toBe(JSON.stringify(expected));
    expect((entry as { editor: Record<string, { main: string }> }).editor.en!.main).toBe(lowered);
    expect(unlowered(entry)).toBeNull();
  },
);

test('reserved globals (library 1, variables 2, titles 3) lower like any tooltip', () => {
  const doc = (hash: number, text: string): Tooltip => ({
    ...tooltip(),
    hash,
    text: { en: { ...tooltip().text.en!, text } },
  });
  const tagged = [
    doc(1, 'export Shared (\n<solar Scorch />\n)'),
    doc(2, 'var Slow = <stasis Slow />'),
    doc(3, 'title Jolt (\n<arc Jolt /> chains.\n)'),
    doc(42, 'import Shared from global\n#Slow and <title it [Jolt] />'),
  ];
  const lowered = [
    doc(1, 'export Shared (\n<solar/>Scorch\n)'),
    doc(2, 'var Slow = <stasis/>Slow'),
    doc(3, 'title Jolt (\n<arc/>Jolt chains.\n)'),
    doc(42, 'import Shared from global\n#Slow and <title it [Jolt] />'),
  ];
  expect(JSON.stringify(exportLegacy(tagged, 0))).toBe(JSON.stringify(exportLegacy(lowered, 0)));
});

test('untagged text is exported as the same string (no copy, no change)', () => {
  const text = 'Gain <solar/>Scorch and <solar /> stacks.';
  const base = tooltip();
  const [entry] = Object.values(
    exportLegacy([{ ...base, text: { en: { ...base.text.en!, text } } }], 0),
  );
  expect((entry as { editor: Record<string, { main: string }> }).editor.en!.main).toBe(text);
});
