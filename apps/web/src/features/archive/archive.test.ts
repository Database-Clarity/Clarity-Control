import { expect, it } from 'vitest';
import { type Tooltip } from '@clarity/core';
import { associateArchive } from './archive';
import { createDraftStore } from '../../stores/drafts';
const now = '2026-11-02T00:00:00Z';
const source: Tooltip = {
  hash: 10,
  text: {
    en: { text: 'Archived English', updatedAt: now, updatedBy: 'old' },
    fr: { text: 'French', updatedAt: now, updatedBy: 'old' },
  },
  associated: [],
  archive: {
    removedAt: now,
    lastSeen: { name: 'Removed', categoryId: 'trait', manifestVersion: 'v1' },
  },
};
const target: Tooltip = {
  hash: 11,
  text: { en: { text: 'Destination', updatedAt: now, updatedBy: 'other' } },
  associated: [12],
};
it('stages exactly one destination draft plus successor metadata without changing source text or other target fields', async () => {
  const store = createDraftStore({ read: async () => ({}), write: async () => {} });
  await store.getState().hydrate();
  const result = associateArchive(source, target, ['fr'], 'maintainer', now);
  store.getState().updateDrafts([
    { base: source, update: () => result.source },
    { base: target, update: () => result.target },
  ]);
  const drafts = store.getState().drafts;
  expect(Object.keys(drafts)).toEqual(['10', '11']);
  expect(drafts[10].next.text).toEqual(source.text);
  expect(drafts[10].next.archive?.successor).toBe(11);
  expect(drafts[11].next.text.en).toEqual(target.text.en);
  expect(drafts[11].next.text.fr?.text).toBe('French');
  expect(drafts[11].next.associated).toEqual([12]);
  expect(source.archive?.successor).toBeUndefined();
  expect(target.text.fr).toBeUndefined();
});
it('requires explicit archival confirmation, a different target, and selected nonempty languages', () => {
  expect(() =>
    associateArchive({ ...source, archive: undefined }, target, ['en'], 'x', now),
  ).toThrow('Confirm archival');
  expect(() => associateArchive(source, source, ['en'], 'x', now)).toThrow('different hash');
  expect(() => associateArchive(source, target, ['de'], 'x', now)).toThrow('non-empty');
});
