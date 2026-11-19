import { expect, it } from 'vitest';
import { resolveAlias } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions } from './guidedDecisions';
import { emptyProgress } from './reviewProgress';
import { reviewCategories } from './reviewCategories';
import { applyReviewProgress, reviewEvidence, reviewQueue } from './reviewQueue';
import { sampleReference } from './sampleReferences';
import { sourceFingerprint } from './reviewProgress';

const row = (name: string, text: string) => ({
  name,
  nameNorm: name.toLowerCase(),
  rowIndex: 50,
  section: 'Traits',
  cell: { plain: text, runs: [{ text }] },
});

it('carries a member approval to its group canonical and keeps its evidence stable', () => {
  const f = guidedFixture();
  const category = f.categories[0];
  const id = category.id;
  // One duplicated in-game item: canonical 210, member 211 (as before and after adoption).
  for (const hash of [210, 211]) {
    f.editor.items[hash] = {
      hash,
      name: 'Grouped Sample',
      categoryId: 'weapon-trait',
      icon: '',
      inGameDescription: 'Grouped mechanics',
    };
    f.editor.bundle.tooltips[hash] = {
      hash,
      text: { en: { text: 'Grouped mechanics', updatedAt: '2026-11-01T00:00:00Z' } },
      associated: [],
    } as never;
  }
  f.source.tabs[0].rows.push(row('Grouped Sample', 'Grouped mechanics'));
  // Fresh objects: the manifest grouping cache is keyed by the items/aliases objects.
  f.editor.items = { ...f.editor.items };
  f.editor.aliases = {};
  const fingerprint = sourceFingerprint(f.source.tabs);
  f.baseline = `synthetic|${fingerprint}`;
  // The app renews the document before deciding; the fixture document still holds the old one.
  f.document.baseline = f.baseline;
  const preAdoption = reviewCategories(
    reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint),
    f.editor,
    f.proposals,
    false,
  );
  const member = preAdoption.flatMap((group) => group.entries).find((entry) => entry.hash === 211)!;
  const record = f.document.categories[id];
  record.hashes.push(210, 211);
  // The owner approved the member before the group existed; the canonical had no sample.
  record.references![211] = sampleReference(
    member,
    id,
    f.baseline,
    '',
    'accepted',
    { tab: f.source.tabs[0], row: f.source.tabs[0].rows.at(-1)! },
    f.source,
  );
  // Adoption: the member resolves to the canonical, whose tooltip survives.
  f.editor.aliases = { 211: { to: 210, kind: 'name' } };
  f.editor.bundle.aliasGroups = {
    version: 1,
    groups: {
      210: {
        members: [210, 211],
        kind: 'S',
        basis: { name: 'Grouped Sample', categoryId: 'weapon-trait' },
        by: { id: '1', login: 'owner' },
        at: '2026-11-01T00:00:00Z',
      },
    },
    rejected: {},
  };
  const evidence = reviewEvidence(f.editor, f.source, {}, fingerprint);
  expect(evidence.some((entry) => entry.hash === 211)).toBe(false);
  expect(resolveAlias(211, f.editor.aliases)).toBe(210);
  const categories = reviewCategories(
    applyReviewProgress(evidence, emptyProgress()),
    f.editor,
    f.proposals,
    false,
  );
  const canonical = categories.flatMap((group) => group.entries).find((entry) => entry.hash === 210)!;
  // Group membership is not content: the canonical's recorded evidence is unchanged.
  const ungrouped = { ...f.editor, aliases: {} };
  const withoutGroup = reviewCategories(
    applyReviewProgress(reviewEvidence(ungrouped, f.source, {}, fingerprint), emptyProgress()),
    ungrouped,
    f.proposals,
    false,
  )
    .flatMap((group) => group.entries)
    .find((entry) => entry.hash === 210)!;
  expect(canonical.sampleEvidence).toBe(withoutGroup.sampleEvidence);
  const decide = (aliases?: typeof f.editor.aliases) =>
    guidedDecisions(
      f.document,
      categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
      undefined,
      undefined,
      undefined,
      aliases,
    )
      .flatMap((group) => group.entries)
      .find((entry) => entry.hash === 210);
  expect(decide(f.editor.aliases)).toMatchObject({ action: 'link', confidence: 'high', ruleId: 'explicit-owner' });
  expect(decide()).not.toMatchObject({ ruleId: 'explicit-owner' });
});

it('learns the owner tab from a sample whose cells changed, but not when its owner text changed', () => {
  const f = guidedFixture();
  const record = f.document.categories[f.categories[0].id];
  record.references = { 100: record.references![100] };
  const fingerprint = sourceFingerprint(f.source.tabs);
  const decide = () => {
    const categories = reviewCategories(
      reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint),
      f.editor,
      f.proposals,
      false,
    );
    const entries = guidedDecisions(
      f.document,
      categories,
      f.proposals,
      f.source,
      `synthetic|${fingerprint}`,
      f.scope,
    ).flatMap((group) => group.entries);
    return (hash: number) => entries.find((entry) => entry.hash === hash);
  };
  expect(decide()(102)).toMatchObject({ action: 'link', confidence: 'high' });
  // A real source edit withdraws that sample's link but still demonstrates its tab.
  f.source.tabs[0].rows[0].cell = { plain: 'Mechanics 0 now', runs: [{ text: 'Mechanics 0 now' }] };
  expect(decide()(100)).toMatchObject({ action: 'owner' });
  expect(decide()(102)).toMatchObject({ action: 'link', confidence: 'high' });
  // The owner's own text changed: the sample no longer says where its sources live.
  f.editor.bundle.tooltips[100] = {
    hash: 100,
    text: { en: { text: 'Rewritten owner text', updatedAt: '2026-11-02T00:00:00Z' } },
    associated: [],
  } as never;
  expect(decide()(102)).toMatchObject({ action: 'owner' });
});
