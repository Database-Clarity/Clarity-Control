import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { checkEdit } from '../src/permissions';
const base: Tooltip = { hash: 10, text: {}, associated: [] };
const promoted: Tooltip = {
  ...base,
  custom: { name: 'Attachment', categoryId: 'attachment-effect' },
};
it('enforces editor-or-higher category promotion on the server', () => {
  for (const role of ['trial', 'translator'] as const)
    expect(() => checkEdit({ login: 'tester', role }, base, promoted)).toThrow('editor role or higher');
  for (const role of ['editor', 'maintainer'] as const)
    expect(() => checkEdit({ login: 'tester', role }, base, promoted)).not.toThrow();
  expect(() =>
    checkEdit({ login: 'tester', role: 'trial' }, promoted, { ...promoted, associated: [11] }),
  ).not.toThrow();
  expect(() => checkEdit({ login: 'tester', role: 'trial' }, promoted, base)).toThrow('editor role or higher');
});
