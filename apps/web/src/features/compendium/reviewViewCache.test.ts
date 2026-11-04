import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { displayMatches } from './displayMatches';
import { emptyProgress } from './reviewProgress';
import { preparedCategories, preparedEvidence, reviewedEntries } from './reviewViewCache';
import { recordDecision } from './rapidReview';
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

it('reuses category projections across navigation while refreshing decisions and original draft text', () => {
  const {
    editor,
    source,
    proposals,
    scope,
    document,
    categories: fixtureCategories,
  } = guidedFixture();
  for (const category of fixtureCategories)
    for (const entry of category.entries) editor.bundle.tooltips[entry.hash] = entry.base;
  const progress = emptyProgress();
  const prepared = structuredClone(
    compactDisplay(
      displayMatches(editor, source, {}, progress, undefined, scope, proposals, document),
    ),
  );
  const evidence = preparedEvidence(prepared, {}, editor, source);
  const entries = reviewedEntries(evidence, progress);
  const categories = preparedCategories(prepared, entries, new Set());
  const sample = categories.flatMap((category) => category.samples)[0];
  expect(sample).toBeDefined();
  const navigation = { ...progress, query: 'another view', selected: sample.hash };
  const navigated = reviewedEntries(evidence, navigation);
  expect(navigated).toBe(entries);
  expect(preparedCategories(prepared, navigated, new Set())).toBe(categories);

  const entry = entries.find((entry) => entry.hash === sample.hash)!;
  const decided = reviewedEntries(
    evidence,
    recordDecision(progress, entry.hash, entry.evidence, 'skipped'),
  );
  const afterDecision = preparedCategories(prepared, decided, new Set());
  expect(afterDecision).not.toBe(categories);
  expect(
    afterDecision.flatMap((category) => category.samples).find((e) => e.hash === sample.hash)
      ?.status,
  ).toBe('skipped');
  expect(sample.status).not.toBe('skipped');

  const base = editor.bundle.tooltips[sample.hash];
  const next = {
    ...base,
    text: { ...base.text, en: { ...base.text.en!, text: 'Current unsaved text' } },
  };
  const edited = reviewedEntries(
    preparedEvidence(prepared, { [sample.hash]: { base, next } }, editor, source),
    progress,
  );
  const afterEdit = preparedCategories(prepared, edited, new Set());
  expect(afterEdit).not.toBe(categories);
  const current = afterEdit
    .flatMap((category) => category.samples)
    .find((e) => e.hash === sample.hash)!;
  expect(current.next).toBe(next);
  expect(current.base).toBe(base);
  expect(sample.next).toBe(base);
});

it('isolates restored scope and replacement worker models without mutating cached categories', () => {
  const { editor, source, proposals, scope, document } = guidedFixture();
  const progress = emptyProgress();
  const prepared = structuredClone(
    compactDisplay(
      displayMatches(editor, source, {}, progress, undefined, scope, proposals, document),
    ),
  );
  const entries = reviewedEntries(preparedEvidence(prepared, {}, editor, source), progress);
  const categories = preparedCategories(prepared, entries, new Set());
  const sample = categories.flatMap((category) => category.samples)[0];
  const scopeHashes = new Set([sample.hash]);
  const restored = preparedCategories(prepared, entries, scopeHashes);
  expect(preparedCategories(prepared, entries, scopeHashes)).toBe(restored);
  expect(restored).not.toBe(categories);
  const category = restored.find((category) =>
    category.samples.some((entry) => entry.hash === sample.hash),
  )!;
  const current = category.entries.find((entry) => entry.hash === sample.hash)!;
  expect(current.scopeRestored).toBe(true);
  expect(category.samples.find((entry) => entry.hash === sample.hash)).toBe(current);
  for (const group of Object.values(category.reasons))
    for (const entry of group) if (entry.hash === sample.hash) expect(entry).toBe(current);
  expect(sample.scopeRestored).toBeFalsy();
  expect(preparedCategories(prepared, entries, new Set())).toBe(categories);

  const updated = {
    ...prepared,
    categories: prepared.categories.map((category) => ({
      ...category,
      name: category.name + ' updated',
    })),
  };
  const replacement = preparedCategories(updated, entries, new Set());
  expect(replacement).not.toBe(categories);
  expect(replacement[0].name).toBe(categories[0].name + ' updated');
});
