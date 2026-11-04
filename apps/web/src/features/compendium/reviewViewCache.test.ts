import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { displayMatches } from './displayMatches';
import { emptyProgress } from './reviewProgress';
import { preparedEvidence, reviewedEntries } from './reviewViewCache';
import { bulkPreviewCurrent, createBulkPreview } from './BulkPreview';
import { compactDisplay } from './compactMatches';
import type { Drafts } from '../../services/draftStorage';

it('keeps bulk acceptance current after a worker clone and preserves real draft text', () => {
  const { editor, source, proposals, scope, document, categories } = guidedFixture();
  const progress = emptyProgress();
  const bases = categories.flatMap((category) => category.entries.map((entry) => entry.base));
  for (const base of bases) {
    editor.bundle.tooltips[base.hash] = {
      ...base,
      text: {
        ...base.text,
        en: {
          text: `Current English ${base.hash}`,
          updatedAt: source.fetchedAt,
          updatedBy: 'fixture',
        },
        de: {
          text: 'Current German translation',
          updatedAt: source.fetchedAt,
          updatedBy: 'fixture',
        },
      },
    };
  }
  const prepared = structuredClone(
    compactDisplay(
      displayMatches(editor, source, {}, progress, undefined, scope, proposals, document),
    ),
  );
  expect(prepared.evidence.every((entry) => entry.base.text.de === undefined)).toBe(true);
  const drafts: Drafts = {};
  const clonedEntries = reviewedEntries(prepared.evidence, progress);
  const stalePreview = createBulkPreview(editor, source, clonedEntries, proposals);
  expect(bulkPreviewCurrent(stalePreview, editor, source, clonedEntries, proposals, drafts)).toBe(
    false,
  );
  const evidence = preparedEvidence(prepared, drafts, editor, source);
  expect(evidence.every((e) => e.base === editor.bundle.tooltips[e.hash])).toBe(true);
  expect(preparedEvidence(prepared, drafts, editor, source)).toBe(evidence);
  const entries = reviewedEntries(evidence, progress);
  const preview = createBulkPreview(editor, source, entries, proposals);
  expect(preview.proposals.length).toBeGreaterThan(0);
  expect(bulkPreviewCurrent(preview, editor, source, entries, proposals, drafts)).toBe(true);
  const base = preview.proposals[0].entry.base;
  const next = structuredClone(base);
  next.text = { ...next.text, en: { ...next.text.en!, text: 'Current unsaved English' } };
  const edited = { [base.hash]: { base, next } };
  expect(bulkPreviewCurrent(preview, editor, source, entries, proposals, edited)).toBe(false);
  const current = preparedEvidence(prepared, edited, editor, source).find(
    (e) => e.hash === base.hash,
  )!;
  expect(current.next).toBe(next);
  expect(current.base).toBe(base);
  expect(current.next.text).toBe(next.text);
  expect(current.next.text.de?.text).toBe('Current German translation');
  const linked = { ...next, compendium: preview.proposals[0].link };
  const linkedEvidence = preparedEvidence(
    prepared,
    { [base.hash]: { base, next: linked } },
    editor,
    source,
  );
  const accepted = reviewedEntries(linkedEvidence, progress).find(
    (entry) => entry.hash === base.hash,
  )!;
  expect(accepted.status).toBe('drafted');
  expect(accepted.next).toBe(linked);
});
