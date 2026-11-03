import { describe, expect, it } from 'vitest';
import { autoLinkCompendium } from './link.js';
import { resolveCompendiumLink } from './resolve.js';
import { setBonusCell } from './setBonus.js';
import { compendiumDataSchema } from './types.js';
import { exportLegacy } from '../exportLegacy.js';

const now = '2026-11-03T17:00:00Z';
const body = '2 Piece | Accretion\nTwo-piece text.\n4 Piece | Doppler Effect\nFour-piece text.';
const data = compendiumDataSchema.parse({
  fetchedAt: now,
  tabs: [
    {
      gid: '1287885342',
      name: 'Armor Perks',
      rows: [
        {
          name: 'Collective Psyche\n\nDesert Perpetual\nRaid',
          nameNorm: 'collective psyche desert perpetual raid',
          rowIndex: 17,
          section: 'Armor Set Bonuses',
          cell: { plain: body, runs: [{ text: body, bold: true }] },
        },
      ],
    },
  ],
});
const item = {
  hash: 900,
  name: 'Collective Psyche (2 pc): Accretion',
  categoryId: 'armor-set-bonus',
  setName: 'Collective Psyche',
  pieceCount: 2 as const,
};
const tooltip = { hash: 900, text: {}, associated: [] };

describe('set-bonus identity and piece-count matching', () => {
  it.each([2, 4] as const)(
    'links only the %s-piece block and refreshes the same block',
    (pieceCount) => {
      const result = autoLinkCompendium(tooltip, { 900: { ...item, pieceCount } }, {}, data, now);
      expect(result.reason).toBe('linked');
      const link = result.next!.compendium!;
      expect(link.setBonusPieces).toBe(pieceCount);
      expect(link.snapshot.plain).toContain(`${pieceCount} Piece`);
      expect(link.snapshot.plain).not.toContain(`${pieceCount === 2 ? 4 : 2} Piece`);
      expect(link.snapshot.runs.every((run) => run.bold)).toBe(true);
      expect(resolveCompendiumLink(link, data)).toMatchObject({
        status: 'ok',
        setBonusPieces: pieceCount,
      });
      const changed = structuredClone(data);
      changed.tabs[0].rows[0].cell = {
        plain: 'No piece labels',
        runs: [{ text: 'No piece labels' }],
      };
      expect(resolveCompendiumLink(link, changed)).toEqual({ status: 'missing' });
    },
  );
  it('never falls back to perk names, a different set, or a selector', () => {
    for (const candidate of [
      { ...item, setName: 'Wrong Set' },
      { ...item, categoryId: 'armor-mod-general', name: 'Set Bonus: Collective Psyche' },
      { ...item, hiddenFromEditor: true },
    ])
      expect(autoLinkCompendium(tooltip, { 900: candidate }, {}, data, now).next).toBeUndefined();
  });
  it('exports written text under the sandbox hash, with no inventory owner', () => {
    const written = {
      ...tooltip,
      text: { en: { text: 'Set bonus text', updatedAt: now, updatedBy: 'editor' } },
    };
    const exported = exportLegacy([written], Date.parse(now), {
      900: { name: item.name, type: 'armor-set-bonus' },
    });
    expect(Object.keys(exported)).toEqual(['900']);
    expect(exported[900]).toMatchObject({
      hash: 900,
      type: 'armor-set-bonus',
      editor: { en: { main: 'Set bonus text' } },
    });
    expect(exported[900]).not.toHaveProperty('itemHash');
  });
});

describe('set bonus sheet background', () => {
  it('keeps the display-only background on the selected block', () => {
    const cell = { plain: body, runs: [{ text: body }], background: '#2e3c4e' };
    expect(setBonusCell(cell, 4)).toEqual({
      plain: '4 Piece | Doppler Effect\nFour-piece text.',
      runs: [{ text: '4 Piece | Doppler Effect\nFour-piece text.' }],
      background: '#2e3c4e',
    });
  });
});
