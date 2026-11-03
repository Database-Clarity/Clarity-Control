import { expect, test } from 'vitest';
import { audit } from './audit.mjs';

const stamp = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'x' };
const tip = (hash, text) => ({
  hash,
  associated: [],
  text: text === undefined ? {} : { en: { text, ...stamp } },
});
const item = (hash, categoryId, baseHash) => ({
  hash,
  name: `Item ${hash}`,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...(baseHash ? { baseHash } : {}),
});

test('classifies variants by what they render and cross-checks derived ones against the converter', async () => {
  const base = 'Does #e${1+#d} damage.\n\nenhanced (\n#e Bonus\n)';
  const report = await audit({
    categories: [
      { id: 'trait', label: 'Trait', group: 'W', order: 1, legacyType: 'Weapon Trait' },
      { id: 'enh', label: 'Enhanced', group: 'W', order: 2, legacyType: 'Weapon Trait Enhanced' },
    ],
    items: {
      10: item(10, 'trait'),
      11: item(11, 'enh', 10),
      12: item(12, 'enh', 10),
      13: item(13, 'enh', 10),
      14: item(14, 'enh', 10),
    },
    aliases: {},
    bundle: {
      sourceCommit: 'test',
      tooltips: {
        2: tip(2, ''),
        3: tip(3, ''),
        10: tip(10, base),
        11: tip(11, 'import main from 10'),
        12: tip(12, 'Their own text'),
        13: tip(13, ''),
        14: tip(14, base),
      },
    },
  });
  expect(report).toMatchObject({
    variants: 4,
    basesWithVariants: 1,
    finderMarks: 1,
    derivedExportDiffers: [],
  });
  expect(report.types.enh).toMatchObject({ variants: 4, derived: 2, override: 2 });
  expect(report.types.enh.languages.en).toEqual({
    importBase: 1,
    ownText: 1,
    emptyOverFilledBase: 1,
    identical: 1,
  });
  expect(report.overrides.map((entry) => entry.hash)).toEqual([12, 13]);
});
