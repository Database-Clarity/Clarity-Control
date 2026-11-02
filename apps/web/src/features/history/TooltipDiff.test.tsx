import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { identityLines } from './TooltipDiff';
import fixture from '../compendium/fixtures/triage.json';

const item = fixture.items['2467967826'] as never as Parameters<typeof identityLines>[2] & {
  name: string;
};
const plain: Tooltip = { hash: 1, text: {}, associated: [] };
const withCustom = (name: string, categoryId: string): Tooltip => ({
  ...plain,
  custom: { name, categoryId },
});
const F = 'Category: Weapon Attachments → Attachment Effects';
const R = 'Category: Attachment Effects → Weapon Attachments';
it('shows only the friendly category line when category is the sole change', () => {
  const promoted = withCustom(item!.name, 'attachment-effect');
  expect(identityLines(plain, promoted, item)).toEqual([F]);
  expect(identityLines(promoted, plain, item)).toEqual([R]);
  expect(identityLines(null, promoted, item)).toEqual([F]);
  expect(identityLines(withCustom(item!.name, 'weapon-attachment'), promoted, item)).toEqual([F]);
});
it('keeps identity changes visible next to the category line', () => {
  expect(identityLines(plain, withCustom('Arbitrary', 'attachment-effect'), item)).toEqual([
    F,
    `Custom identity name: ${item!.name} → Arbitrary`,
  ]);
  expect(identityLines(null, withCustom('Arbitrary', 'attachment-effect'), item)).toEqual([
    F,
    `Custom identity name: ${item!.name} → Arbitrary`,
  ]);
  expect(
    identityLines(
      withCustom('Old', 'weapon-attachment'),
      withCustom('New', 'attachment-effect'),
      item,
    ),
  ).toEqual([F, 'Custom identity name: Old → New']);
});
it('keeps the raw line for other custom changes or when the item is unknown', () => {
  const other = withCustom('X', 'other');
  expect(identityLines(plain, other, item)).toEqual([
    `Custom identity: (none) → ${JSON.stringify(other.custom)}`,
  ]);
  expect(identityLines(plain, withCustom('X', 'attachment-effect'))).toHaveLength(1);
  expect(identityLines(plain, withCustom('X', 'attachment-effect'))[0]).toMatch(
    /^Custom identity:/,
  );
  expect(identityLines(other, other, item)).toEqual([]);
});
