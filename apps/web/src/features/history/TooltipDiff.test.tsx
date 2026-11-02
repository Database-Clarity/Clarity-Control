import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { categorySwitchLine } from './TooltipDiff';

const plain: Tooltip = { hash: 1, text: {}, associated: [] };
const promoted: Tooltip = { ...plain, custom: { name: 'X', categoryId: 'attachment-effect' } };
it('shows friendly category lines for promote and demote', () => {
  expect(categorySwitchLine(plain, promoted)).toBe(
    'Category: Weapon Attachments → Attachment Effects',
  );
  expect(categorySwitchLine(promoted, plain)).toBe(
    'Category: Attachment Effects → Weapon Attachments',
  );
});
it('keeps the raw line for other custom changes', () => {
  const other = { ...plain, custom: { name: 'X', categoryId: 'other' } };
  expect(categorySwitchLine(plain, other)).toBe(undefined);
  const renamed = { ...promoted, custom: { name: 'Y', categoryId: 'weapon-attachment' } };
  expect(categorySwitchLine(promoted, renamed)).toBe(undefined);
  expect(categorySwitchLine(promoted, promoted)).toBe(undefined);
});
