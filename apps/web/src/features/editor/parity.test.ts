import { describe, expect, it } from 'vitest';
import { computeDiagnostics } from './diagnosticRequest';
import { describeGap, readableProse, translationParity, type ParityGap } from './parity';

const gap = (
  kind: ParityGap['kind'],
  key: string,
  english: number,
  translation: number,
): ParityGap => ({ kind, key, english, translation });

describe('translationParity', () => {
  it.each<[string, string, string, ParityGap[]]>([
    [
      'identical structure',
      'Deals <solar/> damage.\nLasts 5s.',
      'Verursacht <solar/> Schaden.\nHält 5 s.',
      [],
    ],
    ['empty translation is untranslated, not incomplete', 'Deals 25 damage.', '   \n', []],
    ['missing icon', 'Grants <arc/> energy.', 'Gewährt Energie.', [gap('icon', 'arc', 1, 0)]],
    ['icon count short', '<solar/> and <solar/>', 'nur <solar/>', [gap('icon', 'solar', 2, 1)]],
    ['element tag counts as its icon', '<void Volatile />', 'Instabil <void/>', []],
    [
      'missing element tag',
      'Applies <void Volatile />.',
      'Wendet Instabil an.',
      [gap('icon', 'void', 1, 0)],
    ],
    ['enhanced arrow: symbol and legacy #e are one icon', '<enhanced/> 10', '#e 10', []],
    [
      'missing variable',
      'Deals #dmg damage.',
      'Verursacht Schaden.',
      [gap('variable', 'dmg', 1, 0)],
    ],
    ['braced and greedy variables are the same name', 'Deals #{dmg}x damage.', '#dmg Schaden', []],
    ['missing number', 'Lasts 10 seconds.', 'Hält Sekunden.', [gap('number', '10', 1, 0)]],
    ['decimal comma equals decimal point', 'Gain 1.5x.', 'Erhalte 1,5x.', []],
    ['repeated number counted', '10 and 10', 'nur 10', [gap('number', '10', 2, 1)]],
    ['numbers glued to letters count', 'x2 for 10s', 'x2 für 10 s', []],
    ['full-width digits read as digits', 'Lasts 10 seconds.', '持续１０秒。', []],
    [
      'numbers inside variable names and maths ignored',
      'Deals #dmg2 ${#a * 3}',
      'Verursacht #dmg2 ${#a * 3}',
      [],
    ],
    ['extra numbers in the translation are fine', 'Lasts 5s.', 'Hält 5 s (oder 7).', []],
    [
      'missing line',
      'First line.\nSecond line.\nThird.',
      'Erste Zeile. Zweite Zeile.\nDritte.',
      [gap('lines', 'lines', 3, 2)],
    ],
    ['blank lines do not count', 'One.\n\nTwo.', 'Eins.\nZwei.', []],
    ['comments do not count', 'One. // note 5\nTwo.', 'Eins.\nZwei.', []],
    [
      'declaration and block lines do not count',
      'var dmg = 25\ntitle Info (\nDeals #dmg.\n)\nLine.',
      'Verursacht #dmg.\nZeile.',
      [],
    ],
  ])('%s', (_name, english, translation, expected) => {
    expect(translationParity(english, translation)).toEqual(expected);
  });

  it('orders lines first, then icons, variables, and numbers', () => {
    expect(translationParity('A <arc/> #v 3\nB', 'A').map((entry) => entry.kind)).toEqual([
      'lines',
      'icon',
      'variable',
      'number',
    ]);
  });
});

describe('describeGap', () => {
  it.each<[ParityGap, string]>([
    [gap('lines', 'lines', 3, 2), 'English has 3 lines; the translation has 2.'],
    [gap('icon', 'arc', 1, 0), 'Icon <arc/> is missing.'],
    [gap('icon', 'arc', 2, 1), 'Icon <arc/> appears twice in English, once here.'],
    [gap('icon', 'enhanced', 1, 0), 'The enhanced arrow is missing.'],
    [gap('variable', 'dmg', 1, 0), 'Variable #dmg is missing.'],
    [gap('number', '10', 3, 1), 'Number 10 appears 3 times in English, once here.'],
  ])('%j', (entry, text) => {
    expect(describeGap(entry)).toBe(text);
  });
});

describe('computeDiagnostics parity', () => {
  const base = {
    lang: 'de' as const,
    globals: { variables: '', titles: '' },
    requireEnglish: false,
  };
  it('checks parity only while translating', () => {
    expect(computeDiagnostics({ ...base, text: 'Text' }).parity).toEqual([]);
    expect(computeDiagnostics({ ...base, text: 'Text', sourceText: 'Text 5' }).parity).toEqual([
      gap('number', '5', 1, 0),
    ]);
  });
});

describe('readableProse', () => {
  it('keeps what a reader sees and drops markup, maths, variables, comments, and structure', () => {
    const english = [
      'var d = 1',
      'Applies <arc/>Jolt and <void Volatile />. // note',
      'For #d ${#d * 2} seconds.',
      ')',
    ].join('\n');
    expect(readableProse(english).split('\n')).toEqual([
      'Applies   Jolt and  Volatile .',
      'For     seconds.',
    ]);
  });

  // Code review 2026-11-14: coloured, bold, PvE, link, and title text is visible; targets are not.
  it.each([
    ['Applies <yellow Voltshot />.', 'Applies  Voltshot .'],
    ['<bold Grants /> <pve 3 /> stacks', ' Grants   3  stacks'],
    ['<title Accuracy Cone Growth [G_conegrowth] /> up', ' Accuracy Cone Growth  up'],
    ['See <link the wiki [https://example.com] /> now', 'See  the wiki  now'],
    ['<arc/> <center/>Arc', '     Arc'],
  ])('reads %j as %j', (line, expected) => {
    expect(readableProse(line)).toBe(expected);
  });
});

describe('translationParity with visible token text', () => {
  it('counts numbers inside colour, PvE, and title tokens', () => {
    expect(translationParity('Grants <green 10 /> handling.', 'Gewährt Handhabung.')).toEqual([
      gap('number', '10', 1, 0),
    ]);
    expect(translationParity('Grants <green 10 /> handling.', 'Gewährt <green 10 />.')).toEqual([]);
    expect(translationParity('<pve 3 /> stacks', '3 Stapel')).toEqual([]);
    // A title's target is not read: its digits are not the reader's numbers.
    expect(translationParity('<title Cone [G_cone2] />', '<title Kegel [G_cone2] />')).toEqual([]);
  });
});
