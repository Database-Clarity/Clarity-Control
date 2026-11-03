import { expect, it } from 'vitest';
import { sameCell } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { sourceFingerprint, rawFingerprint } from './reviewProgress';
import { rebaselineGuidance } from './rebaselineGuidance';
import { reviewQueue } from './reviewQueue';
import { emptyProgress } from './reviewProgress';
import { reviewCategories } from './reviewCategories';

it('ignores background and alignment but retains rendered run styles and cell structure', () => {
  const cell = { plain: 'ab', runs: [{ text: 'ab', bold: true as const }] };
  const display = {
    plain: 'ab',
    background: '#123456',
    runs: [
      { text: 'a', bold: true as const, textAlign: 'center' as const },
      { text: 'b', bold: true as const, textAlign: 'left' as const },
    ],
  };
  expect(sameCell(cell, display)).toBe(true);
  expect(sourceFingerprint(cell)).toBe(sourceFingerprint(display));
  expect(sameCell(cell, { plain: 'ab', runs: [{ text: 'ab' }] })).toBe(false);
  expect(sourceFingerprint([{ row: 1, cell }])).not.toBe(sourceFingerprint([{ row: 2, cell }]));
});

it('renews legacy positive evidence across unrelated sheet changes only after exact source replay', () => {
  const f = guidedFixture();
  const record = f.document.categories[f.categories[0].id];
  record.references = { 100: record.references![100] };
  // Legacy hashes use the exact pre-normalization representation.
  const ref = record.references[100];
  ref.sourceHash = rawFingerprint([
    ref.link!.gid,
    ref.link!.rowKey,
    ref.link!.section,
    ref.link!.cells,
    ref.link!.snapshot,
  ]);
  f.source.tabs[0].rows[1].cell = { plain: 'Unrelated edit', runs: [{ text: 'Unrelated edit' }] };
  f.source.tabs[0].rows[0].cell.background = '#123456';
  f.source.tabs[0].rows[0].cell.runs[0].textAlign = 'center';
  const fingerprint = sourceFingerprint(f.source.tabs);
  const entries = reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint);
  const categories = reviewCategories(entries, f.editor, f.proposals, false);
  const result = rebaselineGuidance(
    f.document,
    categories,
    f.source,
    `new|${fingerprint}`,
    f.scope,
  );
  expect(result.renewed).toEqual([100]);
  f.source.tabs[0].rows[0].cell = { plain: 'Real change', runs: [{ text: 'Real change' }] };
  expect(
    rebaselineGuidance(f.document, categories, f.source, 'new', f.scope).changed.map((r) => r.hash),
  ).toEqual([100]);
  f.editor.items[100].name = 'Changed identity';
  const changed = reviewCategories(
    reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint),
    f.editor,
    f.proposals,
    false,
  );
  expect(rebaselineGuidance(f.document, changed, f.source, 'new', f.scope).renewed).toEqual([]);
});

it('keeps positive, negative and skipped approvals when only the sheet presentation changes', () => {
  const f = guidedFixture();
  for (const row of f.source.tabs[0].rows) {
    row.cell.background = '#abcdef';
    row.cell.runs[0].textAlign = 'right';
  }
  const fingerprint = sourceFingerprint(f.source.tabs);
  const categories = reviewCategories(
    reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint),
    f.editor,
    f.proposals,
    false,
  );
  const result = rebaselineGuidance(
    f.document,
    categories,
    f.source,
    `new|${fingerprint}`,
    f.scope,
  );
  expect(result.renewed).toHaveLength(5);
  expect(result.changed).toEqual([]);
});
