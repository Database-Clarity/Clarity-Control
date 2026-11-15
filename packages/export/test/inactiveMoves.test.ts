import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  exportLegacy,
  exportWithInactiveMoves,
  legacyDatabaseSchema,
  migrateLegacy,
  type Tooltip,
} from '@clarity/core';
import { buildLegacy, legacyPresets, type LegacyInput } from '../src/index.js';

// The fixtures supply catalog facts; the converter retains its historical stricter input type.
const consumerInput = (perks: ReturnType<typeof exportLegacy>) => ({ perks }) as LegacyInput;

// An empty inactive file must leave the consumer input byte-identical; every legacy build is a pure
// function of that input, so identical serialised input means identical bytes in every preset.
// (Building all 8 presets twice from the real fixture ran past 60 s on loaded CI shards.)
it('keeps the real-data consumer input byte-identical with an empty inactive file', () => {
  const source = legacyDatabaseSchema.parse(
    JSON.parse(
      readFileSync(new URL('../../core/test/fixtures/intermediate.json', import.meta.url), 'utf8'),
    ),
  );
  const tooltips = migrateLegacy(source);
  const facts = Object.fromEntries(
    Object.entries(source.perks).map(([hash, perk]) => [hash, { name: perk.name, type: perk.type }]),
  );
  const before = consumerInput(exportLegacy(tooltips, 0, facts));
  const after = consumerInput(exportWithInactiveMoves(tooltips, 0, facts, {}, {}));
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  // One cheap end-to-end build keeps the converter path itself covered.
  const preset = legacyPresets.find((name) => name === 'vaultZero') ?? legacyPresets[0]!;
  expect(buildLegacy(after, preset)).toEqual(buildLegacy(before, preset));
}, 60_000);

it('removes only a moved fixture item and its stub from every consumer file', () => {
  const tooltip = (hash: number, text: string): Tooltip => ({
    hash,
    associated: [],
    text: { en: { text, updatedBy: 'alice', updatedAt: '2026-11-14T00:00:00Z' } },
  });
  const tooltips = [
    tooltip(1, ''),
    tooltip(2, ''),
    tooltip(3, ''),
    tooltip(142, 'Moved text'),
    tooltip(99, 'Retained text'),
  ];
  const facts = Object.fromEntries(
    tooltips.map(({ hash }) => [hash, { name: `Perk ${hash}`, type: 'Weapon Perk' }]),
  );
  facts['77'] = { name: 'Alias', type: 'Weapon Perk' };
  const aliases = { 77: { to: 142, kind: 'frame' as const } };
  const before = consumerInput(exportLegacy(tooltips, 0, facts, aliases));
  const after = consumerInput(
    exportWithInactiveMoves(tooltips, 0, facts, aliases, {
      142: { by: 1, at: '2026-11-14T00:00:00Z' },
    }),
  );
  const restored = consumerInput(
    exportWithInactiveMoves(tooltips, 0, facts, aliases, {
      142: { by: 1, at: '2026-11-14T00:00:00Z', inactive: false },
    }),
  );
  for (const preset of legacyPresets) {
    expect(buildLegacy(restored, preset), `${preset}: restore`).toEqual(
      buildLegacy(before, preset),
    );
    const original = JSON.parse(new TextDecoder().decode(buildLegacy(before, preset)));
    const actual = JSON.parse(new TextDecoder().decode(buildLegacy(after, preset)));
    expect(original, preset).toHaveProperty('142');
    expect(original, preset).toHaveProperty('77');
    delete original[142];
    delete original[77];
    expect(actual, preset).toEqual(original);
  }
});
