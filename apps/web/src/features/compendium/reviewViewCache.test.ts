import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { displayMatches } from './displayMatches';
import { emptyProgress } from './reviewProgress';
import {
  preparedCategories,
  preparedEvidence,
  preparedProposals,
  reviewEntryProjection,
  reviewedEntries,
  reviewScopeHashes,
  warmPreparedProposals,
} from './reviewViewCache';
import { recordDecision } from './rapidReview';
import { bulkPreviewCurrent, createBulkPreview } from './BulkPreview';
import { compactDisplay } from './compactMatches';
import type { Drafts } from '../../services/draftStorage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function idleProposalFixture() {
  const { editor, source, proposals: core, scope, document } = guidedFixture();
  const prepared = displayMatches(
    editor,
    source,
    {},
    emptyProgress(),
    undefined,
    scope,
    core,
    document,
  );
  const extra = core.values().next().value!;
  for (let index = 0; index < 512; index++) core.set(500_000 + index, extra);
  const callbacks = new Map<number, IdleRequestCallback>();
  let id = 0;
  let pending = false;
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callbacks.set(++id, callback);
    return id;
  });
  vi.stubGlobal('cancelIdleCallback', (key: number) => callbacks.delete(key));
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
  const tick = (timeRemaining = 50) => {
    const next = callbacks.entries().next().value;
    if (!next) throw new Error('Expected queued proposal warm-up');
    callbacks.delete(next[0]);
    next[1]({ didTimeout: false, timeRemaining: () => timeRemaining });
  };
  return {
    prepared,
    core,
    callbacks,
    tick,
    pending: (value: boolean) => {
      pending = value;
    },
  };
}

it('yields proposal warm-up to input and low idle budgets, then publishes the complete projection', () => {
  const { prepared, core, callbacks, tick, pending } = idleProposalFixture();
  const expected = preparedProposals({ ...prepared }, core);
  const original = core[Symbol.iterator].bind(core);
  let visited = 0;
  vi.spyOn(core, Symbol.iterator).mockImplementation(function* () {
    for (const entry of original()) {
      visited++;
      yield entry;
    }
    return undefined;
  });
  const cancel = warmPreparedProposals(prepared, core);
  expect(visited).toBe(0);
  pending(true);
  tick();
  expect(visited).toBe(0);
  pending(false);
  tick(0);
  expect(visited).toBe(0);
  tick();
  expect(visited).toBeGreaterThan(0);
  expect(visited).toBeLessThan(core.size);
  const beforeInput = visited;
  pending(true);
  tick();
  expect(visited).toBe(beforeInput);
  pending(false);
  for (let count = 0; callbacks.size && count < 1000; count++) tick();
  expect(callbacks.size).toBe(0);
  const complete = preparedProposals(prepared, core);
  expect(complete).toEqual(expected);
  expect(preparedProposals(prepared, core)).toBe(complete);
  cancel();
});

it('cancels partial proposal warm-up without exposing partial matches or replacing a foreground result', () => {
  const { prepared, core, callbacks, tick } = idleProposalFixture();
  const cancel = warmPreparedProposals(prepared, core);
  tick();
  cancel();
  expect(callbacks.size).toBe(0);
  const foreground = preparedProposals(prepared, core);
  expect(foreground.size).toBeGreaterThanOrEqual(core.size);
  for (const [hash, match] of prepared.matches) expect(foreground.get(hash)?.match).toBe(match);

  const other = { ...prepared };
  warmPreparedProposals(other, core);
  tick();
  const openedDuringWarmup = preparedProposals(other, core);
  tick();
  expect(callbacks.size).toBe(0);
  expect(preparedProposals(other, core)).toBe(openedDuringWarmup);
});

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

it('reuses entry navigation indexes and refreshes them for scope, proposals, and decisions', () => {
  const { editor, source, proposals, scope, document } = guidedFixture();
  const progress = emptyProgress();
  const prepared = displayMatches(
    editor,
    source,
    {},
    progress,
    undefined,
    scope,
    proposals,
    document,
  );
  const evidence = preparedEvidence(prepared, {}, editor, source);
  const entries = reviewedEntries(evidence, progress);
  const categories = preparedCategories(prepared, entries, new Set());
  const sourceScope = [100];
  const inScope = reviewScopeHashes(categories, entries, sourceScope);
  const initial = reviewEntryProjection(entries, inScope, proposals);
  expect(initial.entries.map((entry) => entry.hash)).toEqual([100]);
  expect(initial.index.byGroup.get('catalog:weapon-trait')?.map((entry) => entry.hash)).toEqual([
    100,
  ]);
  expect(initial.index.search.get(100)).toBe('sample 100 100');

  // Going to category view and back, or remounting the workspace, retains
  // indexes without tying them to a selected hash or URL filter.
  const navigated = reviewedEntries(evidence, { ...progress, selected: 101, query: 'sample' });
  expect(navigated).toBe(entries);
  const navigatedScope = reviewScopeHashes(categories, navigated, sourceScope);
  expect(navigatedScope).toBe(inScope);
  expect(reviewEntryProjection(navigated, navigatedScope, proposals)).toBe(initial);

  const otherScope = reviewScopeHashes(categories, entries, [101]);
  expect(reviewEntryProjection(entries, otherScope, proposals).entries.map((e) => e.hash)).toEqual([
    101,
  ]);
  expect(initial.entries.map((entry) => entry.hash)).toEqual([100]);
  const withoutLink = new Map(proposals);
  withoutLink.set(100, { ...proposals.get(100)!, link: undefined });
  const unlinked = reviewEntryProjection(entries, inScope, withoutLink);
  expect(unlinked.index.byProposal.get(false)?.map((entry) => entry.hash)).toContain(100);
  expect(initial.index.byProposal.get(true)?.map((entry) => entry.hash)).toContain(100);

  const entry = entries.find((entry) => entry.hash === 101)!;
  const decided = reviewedEntries(
    evidence,
    recordDecision(progress, entry.hash, entry.evidence, 'skipped'),
  );
  const decidedScope = reviewScopeHashes(categories, decided, sourceScope);
  const afterDecision = reviewEntryProjection(decided, decidedScope, proposals);
  // Reviewed rows remain navigable even if the automatic source scope did
  // not include them. The old open-only projection must stay unchanged.
  expect(afterDecision.index.byStatus.get('skipped')?.map((entry) => entry.hash)).toEqual([101]);
  expect(initial.index.byStatus.get('skipped')).toBeUndefined();

  const base = entries.find((entry) => entry.hash === 100)!.base;
  const next = {
    ...base,
    text: { ...base.text, en: { ...base.text.en!, text: 'Current draft text after returning' } },
  };
  const edited = reviewedEntries(
    preparedEvidence(prepared, { 100: { base, next } }, editor, source),
    progress,
  );
  const editedScope = reviewScopeHashes(categories, edited, sourceScope);
  const afterEdit = reviewEntryProjection(edited, editedScope, proposals);
  expect(afterEdit.entries[0].next).toBe(next);
  expect(initial.entries[0].next).toBe(base);
});
