import { expect, it } from 'vitest';
import { approvalEvidence } from './approvalEvidence';
import shipped from './approved-guidance.v1.json';
import type { CompendiumMatch } from '@clarity/core';

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
