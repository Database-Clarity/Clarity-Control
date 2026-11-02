import { expect, it } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { itemFor } from '../navigation/catalog';
import { reviewEvidence } from '../compendium/reviewQueue';
import { archivedItemFor } from './archive';
import { archiveChangeLine, formatArchiveDate } from './archiveFormat';

const time = '2026-11-02T00:00:00Z';
const text = { en: { text: 'Removed words', updatedAt: time, updatedBy: 'old' } };
const present: Tooltip = { hash: 10, text, associated: [] };
const removed: Tooltip = {
  hash: 4000000000,
  text,
  associated: [],
  archive: {
    removedAt: time,
    lastSeen: { name: 'Gone', categoryId: 'trait', manifestVersion: 'v1' },
  },
};
const orphan: Tooltip = { hash: 4000000001, text, associated: [] };
function data(tooltips: Tooltip[]): EditorData {
  return {
    categories: [],
    items: {
      10: { hash: 10, name: 'Present', categoryId: 'trait', inGameDescription: '', icon: '' },
    },
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: time,
      tooltips: Object.fromEntries(tooltips.map((tooltip) => [tooltip.hash, tooltip])),
      permissions: { users: {} },
      pushed: {},
    },
  };
}
const source: CompendiumData = { fetchedAt: time, tabs: [] };

it('keeps the shared itemFor (Compendium missing-link list, review fingerprints) blind to removed and orphan tooltips', () => {
  const editor = data([present, removed, orphan]);
  // CompendiumPage builds its missing-link list from `itemFor(hash) → !!item`.
  expect(itemFor(removed.hash, editor)).toBeUndefined();
  expect(itemFor(orphan.hash, editor)).toBeUndefined();
  expect(itemFor(10, editor)?.name).toBe('Present');
  // The Archive/tooltip-page helper is the only one that synthesizes an identity.
  expect(archivedItemFor(removed.hash, editor)?.name).toBe('Gone');
  expect(archivedItemFor(orphan.hash, editor)?.hash).toBe(orphan.hash);
  expect(archivedItemFor(2, editor)).toBeUndefined();
  expect(archivedItemFor(10, editor)).toBe(editor.items[10]);
});

it('produces identical review evidence for removed tooltips with or without the archive field', () => {
  const withArchive = reviewEvidence(data([present, removed]), source, {}, 'fp');
  const withoutArchive = reviewEvidence(
    data([present, { ...removed, archive: undefined }]),
    source,
    {},
    'fp',
  );
  expect(withArchive).toEqual(
    withoutArchive.map((entry) =>
      entry.hash === removed.hash ? { ...entry, base: removed, next: removed } : entry,
    ),
  );
  const entry = withArchive.find((candidate) => candidate.hash === removed.hash)!;
  expect(entry.name).toBe(String(removed.hash));
  expect(entry.category).toBe('other');
});

it('formats dates and archive history lines readably', () => {
  expect(formatArchiveDate('2026-02-15T00:00:00Z')).toBe('15 Feb 2026');
  expect(formatArchiveDate('not a date')).toBe('not a date');
  expect(archiveChangeLine(undefined, undefined)).toBeUndefined();
  expect(archiveChangeLine(undefined, removed.archive)).toBe(
    'Archive: archived as "Gone" (removed 2 Nov 2026)',
  );
  expect(archiveChangeLine(removed.archive, undefined)).toContain('restored');
  expect(archiveChangeLine(removed.archive, { ...removed.archive!, successor: 11 })).toBe(
    'Archive: successor set to 11',
  );
  expect(archiveChangeLine(undefined, removed.archive)).not.toContain('{');
});
