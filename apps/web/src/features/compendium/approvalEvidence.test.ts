import { expect, it } from 'vitest';
import { approvalEvidence, approvedSourceChanged } from './approvalEvidence';
import shipped from './approved-guidance.v1.json';
import {
  normaliseCompendiumName,
  type CompendiumCell,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumMatch,
} from '@clarity/core';

it('uses source snapshots from ordinary shipped approvals and rejects a different identity', () => {
  const record = Object.values(shipped.categories)
    .flatMap((c) => Object.values(c.references ?? {}))
    .find((r) => 'link' in r && r.link)! as unknown as {
    hash: number;
    name: string;
    categoryId: string;
    link: { gid: string; rowKey: string; snapshot: unknown };
  };
  const match = {
    tab: { gid: record.link.gid },
    row: { name: record.link.rowKey },
  } as CompendiumMatch;
  expect(approvalEvidence(record.hash, record.name, record.categoryId.slice(8), match)).toEqual(
    record.link.snapshot,
  );
  expect(
    approvalEvidence(record.hash, 'Wrong name', record.categoryId.slice(8), match),
  ).toBeUndefined();
  expect(approvalEvidence(record.hash, record.name, 'wrong-category', match)).toBeUndefined();
  expect(
    approvalEvidence(record.hash, record.name, record.categoryId.slice(8), {
      ...match,
      tab: { ...match.tab, gid: 'wrong' },
    }),
  ).toBeUndefined();
});

it('says an approved link changed only while its own source differs, not for other sheet edits', () => {
  const record = Object.values(shipped.categories)
    .flatMap((c) => Object.values(c.references ?? {}))
    .find((r) => 'link' in r && r.link && !r.link.parts && !r.link.cells)! as unknown as {
    hash: number;
    name: string;
    categoryId: string;
    link: CompendiumLink;
  };
  const entry = { hash: record.hash, name: record.name, category: record.categoryId.slice(8) };
  const { gid, rowKey, snapshot } = record.link;
  const row = (name: string, cell: CompendiumCell) => ({
    name,
    nameNorm: normaliseCompendiumName(name),
    rowIndex: 1,
    anchor: { row: 1, col: 0 },
    cell,
  });
  const other = row('Unrelated', { plain: 'Edited elsewhere', runs: [] });
  const source = (cell: CompendiumCell): CompendiumData => ({
    fetchedAt: '2026-11-23T00:00:00Z',
    tabs: [{ gid, name: 'Weapon Perks', rows: [row(rowKey, cell), other] }],
  });
  expect(approvedSourceChanged(entry, source(snapshot))).toBe(false);
  const edited = { plain: `${snapshot.plain} more`, runs: [{ text: `${snapshot.plain} more` }] };
  expect(approvedSourceChanged(entry, source(edited))).toBe(true);
  expect(approvedSourceChanged({ ...entry, hash: 5 }, source(edited))).toBe(false);
});
