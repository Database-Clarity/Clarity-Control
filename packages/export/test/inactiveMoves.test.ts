import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  exportLegacy,
  exportWithInactiveMoves,
  legacyDatabaseSchema,
  migrateLegacy,
  type Tooltip,
} from '@clarity/core';
import { buildLegacy, legacyPresets } from '../src/index.js';

it.each(legacyPresets)(
  'keeps real-data %s bytes identical with an empty inactive file',
  (preset) => {
    const source = legacyDatabaseSchema.parse(
      JSON.parse(
        readFileSync(
          new URL('../../core/test/fixtures/intermediate.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    const tooltips = migrateLegacy(source);
    const facts = Object.fromEntries(
      Object.entries(source.perks).map(([hash, perk]) => [
        hash,
        { name: perk.name, type: perk.type },
      ]),
    );
    const before = { perks: exportLegacy(tooltips, 0, facts) };
    const after = { perks: exportWithInactiveMoves(tooltips, 0, facts, {}, {}) };
    expect(buildLegacy(after, preset), preset).toEqual(buildLegacy(before, preset));
  },
  60_000,
);

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
  const before = { perks: exportLegacy(tooltips, 0, facts, aliases) };
  const after = {
    perks: exportWithInactiveMoves(tooltips, 0, facts, aliases, {
      142: { by: 1, at: '2026-11-14T00:00:00Z' },
    }),
  };
  for (const preset of legacyPresets) {
    const original = JSON.parse(new TextDecoder().decode(buildLegacy(before, preset)));
    const actual = JSON.parse(new TextDecoder().decode(buildLegacy(after, preset)));
    expect(original, preset).toHaveProperty('142');
    expect(original, preset).toHaveProperty('77');
    delete original[142];
    delete original[77];
    expect(actual, preset).toEqual(original);
  }
});
