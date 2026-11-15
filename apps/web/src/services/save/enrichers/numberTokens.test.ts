import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { stampRevisions } from './metadata';

const date = '2026-11-01T00:00:00.000Z';
const nextDate = '2026-11-02T00:00:00.000Z';
const tooltip: Tooltip = {
  hash: 42,
  associated: [],
  text: {
    en: { text: 'Deals 5 damage.', updatedAt: date, updatedBy: 'editor' },
    de: {
      text: 'Verursacht 5 Schaden.',
      updatedAt: date,
      updatedBy: 'translator',
      sourceUpdatedAt: date,
    },
  },
};

it('literal -> token, and token -> literal preserve every translation stamp', () => {
  const next = structuredClone(tooltip);
  next.text.de!.text = 'Verursacht #{=1} Schaden.';
  const stamped = stampRevisions(tooltip, next, 'current', nextDate);
  expect(stamped.text.de).toEqual({ ...tooltip.text.de, text: next.text.de!.text });
  expect(stampRevisions(stamped, tooltip, 'current', nextDate)).toEqual(tooltip);
});
it('changed resolved values, wording, and unknown tokens cannot masquerade as markup-only', () => {
  for (const text of ['Verursacht #{=1} zusätzlichen Schaden.', 'Verursacht #{=2} Schaden.']) {
    const next = structuredClone(tooltip);
    next.text.de!.text = text;
    expect(stampRevisions(tooltip, next, 'current', nextDate).text.de).toMatchObject({
      updatedAt: nextDate,
      updatedBy: 'current',
    });
  }
  const next = structuredClone(tooltip);
  next.text.en!.text = 'Deals 6 damage.';
  next.text.de!.text = 'Verursacht #{=1} Schaden.';
  expect(stampRevisions(tooltip, next, 'current', nextDate).text.de).toMatchObject({
    updatedAt: nextDate,
    sourceUpdatedAt: nextDate,
  });
});
it('conversion inside comments follows the same resolved-byte revision rule', () => {
  const before = structuredClone(tooltip);
  before.text.de!.text = '/* 5 */\nVerursacht 5 Schaden.';
  const next = structuredClone(before);
  next.text.de!.text = '/* #{=1} */\nVerursacht #{=1} Schaden.';
  expect(stampRevisions(before, next, 'current', nextDate).text.de).toEqual({
    ...before.text.de,
    text: next.text.de!.text,
  });
});
