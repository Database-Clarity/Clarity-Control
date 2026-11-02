import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { checkEdit } from '../src/permissions';
const base: Tooltip = { hash: 10, text: {}, associated: [] };
const archived: Tooltip = {
  ...base,
  archive: {
    removedAt: '2026-11-02T00:00:00Z',
    lastSeen: { name: 'Old', categoryId: 'trait', manifestVersion: 'v1' },
  },
};
it('requires maintainers to confirm or associate archives and rejects trial/translator archive writes', () => {
  for (const role of ['editor', 'trial', 'translator'] as const) {
    expect(() => checkEdit({ role, login: 'tester' }, base, archived)).toThrow(
      'Archive changes require maintainer',
    );
    expect(() =>
      checkEdit({ role, login: 'tester' }, archived, {
        ...archived,
        archive: { ...archived.archive!, successor: 11 },
      }),
    ).toThrow();
  }
  expect(() => checkEdit({ role: 'maintainer', login: 'tester' }, base, archived)).not.toThrow();
  expect(() => checkEdit({ role: 'editor', login: 'tester' }, archived, base)).not.toThrow();
  for (const role of ['trial', 'translator'] as const)
    expect(() => checkEdit({ role, login: 'tester' }, archived, base)).toThrow();
});
