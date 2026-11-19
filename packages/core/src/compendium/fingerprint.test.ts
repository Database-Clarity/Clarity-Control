import { expect, it } from 'vitest';
import { fingerprintCell, sameCell } from './types.js';
import { normaliseEvidenceText } from './evidenceText.js';

const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });

it('shares one formatting equivalence between cell text and authored English', () => {
  const pairs: [string, string][] = [
    ['Deals 12 damage.\n\nSecond line.', 'Deals 12 damage.\r\n\r\nSecond line.'],
    ['Arc  –  Solar', 'Arc - Solar'],
    ["Tommy's Matchbook", 'Tommy\u2019s Matchbook'],
    ['"Precision Hits"', '\u201cPrecision Hits\u201d'],
    ['Zero\u200bwidth', 'Zerowidth'],
    ['Extra   spaces', 'Extra spaces'],
  ];
  for (const [before, after] of pairs) {
    expect(normaliseEvidenceText(before), before).toBe(normaliseEvidenceText(after));
    expect(fingerprintCell(cell(before)), before).toEqual(fingerprintCell(cell(after)));
  }
});

it('never folds wording, numbers, or other symbols', () => {
  const pairs: [string, string][] = [
    ['Deals 12 damage.', 'Deals 21 damage.'],
    ['Deals 12 damage.', 'Deals 12 damage now.'],
    ['Arc + Solar', 'Arc - Solar'],
    ['7.5 metres', '6 metres'],
    ['100% damage', '100 damage'],
  ];
  for (const [before, after] of pairs) {
    expect(normaliseEvidenceText(before), before).not.toBe(normaliseEvidenceText(after));
    expect(fingerprintCell(cell(before)), before).not.toEqual(fingerprintCell(cell(after)));
  }
});

it('keeps strict cell comparison and run styles outside the fingerprint', () => {
  expect(sameCell(cell('Arc  –  Solar'), cell('Arc - Solar'))).toBe(false);
  const bold = { plain: 'Arc', runs: [{ text: 'Arc', bold: true as const }] };
  expect(fingerprintCell(cell('Arc'))).not.toEqual(fingerprintCell(bold));
  expect(normaliseEvidenceText(' a\t b \n ')).toBe('a b');
});
