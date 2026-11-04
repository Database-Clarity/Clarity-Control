import { expect, it } from 'vitest';
import { compendiumSimilarity, normaliseCompendiumName } from './resolve.js';
import { compendiumIdentifiers } from './config.js';

function referenceName(name: string) {
  return name
    .replace(/(?:\s*[(\u005b][^()[\]]*[)\u005d])+\s*$/gu, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function referenceSimilarity(left: string, right: string) {
  if (!left.trim() || !right.trim()) return left === right ? 1 : 0;
  const grams = (text: string) => {
    const value = referenceName(text);
    return new Set(
      value.length < 3
        ? [value]
        : Array.from({ length: value.length - 2 }, (_, i) => value.slice(i, i + 3)),
    );
  };
  const a = grams(left),
    b = grams(right);
  return (2 * [...a].filter((value) => b.has(value)).length) / (a.size + b.size);
}

it('keeps exact Unicode normalization and similarity across repeated and changed text', () => {
  const texts = [
    '',
    ' ',
    'a',
    'é',
    'Écho [PvE]',
    'Echo (2 Energy)',
    'ﬀ & café',
    '火力 + ١٢٣',
    'a\u0301a\u0308',
    '🌟💥',
    'Damage\n\n+50% (PvP)',
  ];
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const left of texts) {
      expect(normaliseCompendiumName(left)).toBe(referenceName(left));
      for (const right of texts)
        expect(compendiumSimilarity(left, right)).toBe(referenceSimilarity(left, right));
      for (const right of texts) {
        const actual = compendiumSimilarity(left, right, 0.6);
        const expected = referenceSimilarity(left, right);
        expect(actual >= 0.6).toBe(expected >= 0.6);
        if (expected >= 0.6) expect(actual).toBe(expected);
      }
    }
    texts[5] += ' changed';
  }
});

it('retains results after both text caches have evicted earlier entries', () => {
  const left = 'Original dégâts and armor',
    right = 'Original damage and armor';
  const expected = referenceSimilarity(left, right);
  for (let i = 0; i < 9000; i++) {
    const name = `Écho ${i} & armor (PvE)`;
    expect(normaliseCompendiumName(name)).toBe(referenceName(name));
    expect(compendiumSimilarity(name, right)).toBe(referenceSimilarity(name, right));
  }
  expect(compendiumSimilarity(left, right)).toBe(expected);
  expect(normaliseCompendiumName('Écho [PvE]')).toBe('echo');
});

it('keeps multiline and Roman identifier expansion independent of caller mutations', () => {
  const name = '  ↑ Arc I–III\n+ Écho\n';
  const expected = compendiumIdentifiers(name);
  expect(expected).toContain('Arc I');
  expect(expected).toContain('Arc II');
  expect(expected).toContain('Arc III');
  expect(expected).toContain('Écho');
  const edited = compendiumIdentifiers(name);
  edited.sort().splice(0, 2, 'Changed');
  expect(compendiumIdentifiers(name)).toEqual(expected);
  expect(compendiumIdentifiers(name + 'Changed')).not.toEqual(expected);
});
