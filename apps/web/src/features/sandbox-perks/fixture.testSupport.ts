import type { SandboxPointers, Tooltip } from '@clarity/core';
import type { Item } from '../../services/generatorSchema';
import type { WorklistInput } from './model';

/** One row per suggestion bucket, plus the compiled-check cases (see model.test.ts). */
export const at = '2026-11-12T20:00:00Z';
const tooltip = (hash: number, text: Partial<Record<'en' | 'de', string>>): Tooltip => ({
  hash,
  associated: [],
  text: Object.fromEntries(
    Object.entries(text).map(([lang, value]) => [
      lang,
      { text: value, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'fixture' },
    ]),
  ),
});
const item = (hash: number, name: string, categoryId = 'weapon-trait'): Item => ({
  hash,
  name,
  icon: '',
  categoryId,
  inGameDescription: '',
});

export function fixture(saved: SandboxPointers = { version: 1, pointers: {} }): WorklistInput {
  return {
    // 700: English text is the same (11 imports 10), German differs: bulk must skip it.
    // 701: the same in every language (13 imports 12 in both): bulk applies it.
    // 702: same English; German compiles the same in base form, differently when enhanced.
    // 703: Bungie's name matches one candidate.  704: no Bungie name.  705: same name, other text.
    // 706: anything else.
    conflicts: {
      700: [10, 11],
      701: [12, 13],
      702: [14, 15],
      703: [16, 17],
      704: [16, 18],
      705: [20, 21],
      706: [16, 20],
    },
    aliases: { 99: { to: 16, kind: 'frame' } },
    tooltips: {
      10: tooltip(10, { en: 'Gain Haste.', de: 'Erhalte Eile.' }),
      11: tooltip(11, { en: 'import main from 10', de: 'Anders.' }),
      12: tooltip(12, { en: 'Gain Haste.', de: 'Erhalte Eile.' }),
      13: tooltip(13, { en: 'import main from 12', de: 'import main from 12' }),
      14: tooltip(14, { en: 'Gain Haste.', de: 'Erhalte Eile.\nenhanced (\nUnd mehr.\n)' }),
      15: tooltip(15, { en: 'import main from 14', de: 'Erhalte Eile.' }),
      16: tooltip(16, { en: 'Reaper text.' }),
      17: tooltip(17, { en: 'Double dodge.' }),
      18: tooltip(18, { en: 'Other.' }),
      20: tooltip(20, { en: 'Charged bolts.' }),
      21: tooltip(21, { en: 'Charged bolts, enhanced.' }),
    },
    items: Object.fromEntries(
      [
        item(10, 'Haste A'),
        item(11, 'Haste B'),
        item(12, 'Haste C'),
        item(13, 'Haste D'),
        item(14, 'Haste E'),
        item(15, 'Haste F'),
        item(16, 'Reaper', 'armor-mod-general'),
        item(17, 'Double Dodge', 'armor-trait-exotic'),
        item(18, 'Other'),
        item(20, 'Charged Bolts'),
        item(21, 'Charged Bolts', 'weapon-perk-enhanced'),
      ].map((value) => [value.hash, value]),
    ),
    perkText: {
      700: ['Haste', 'You are faster.'],
      701: ['Haste', 'You are faster.'],
      702: ['Haste', 'You are faster.'],
      703: ['Reaper', 'Kills spawn orbs.'],
      704: ['', ''],
      705: ['Charged Bolts', 'Bolts.'],
      706: ['Something', 'Else.'],
    },
    saved,
  };
}
