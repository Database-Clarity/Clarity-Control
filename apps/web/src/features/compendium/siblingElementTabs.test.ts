import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions } from './guidedDecisions';
import { sampleReference } from './sampleReferences';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import { reviewQueue } from './reviewQueue';
import { reviewCategories } from './reviewCategories';
import { proposalFor } from './rapidReview';

function siblingFixture(fragment = false) {
  const f = guidedFixture();
  const categoryId = fragment ? 'subclass-fragment' : 'subclass-aspect';
  const tabs = [
    { gid: '618967225', name: 'Arc', hashes: [100, 104, 105], prefix: 'Spark' },
    { gid: '1186062409', name: 'Solar', hashes: [101], prefix: 'Ember' },
    { gid: '1918152785', name: 'Prismatic', hashes: [103], prefix: 'Facet' },
    { gid: '1870531554', name: 'Strand', hashes: [102], prefix: 'Thread' },
  ];
  f.source.tabs = tabs.map(({ hashes, prefix, ...tab }) => ({
    ...tab,
    rows: hashes.map((hash) => {
      f.editor.items[hash].categoryId = categoryId;
      f.editor.items[hash].name = fragment ? prefix + ' of Sample ' + hash : 'Sample ' + hash;
      return {
        rowIndex: hash,
        name: 'Sample ' + hash,
        nameNorm: 'sample ' + hash,
        section: fragment ? 'Fragments' : 'Aspects',
        cell: { plain: 'Mechanics ' + hash, runs: [{ text: 'Mechanics ' + hash }] },
      };
    }),
  }));
  const fingerprint = sourceFingerprint(f.source.tabs);
  f.baseline = 'synthetic|' + fingerprint;
  const entries = reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint);
  f.proposals = new Map(entries.map((e) => [e.hash, proposalFor(e.base, f.editor, f.source)]));
  f.categories = reviewCategories(entries, f.editor, f.proposals, false, false, f.source);
  const category = f.categories[0];
  const references = Object.fromEntries(
    [100, 101, 103].map((hash) => {
      const tab = f.source.tabs.find((tab) => tab.rows.some((row) => row.rowIndex === hash))!;
      return [
        hash,
        sampleReference(
          category.entries.find((e) => e.hash === hash)!,
          category.id,
          f.baseline,
          '',
          'accepted',
          { tab, row: tab.rows.find((row) => row.rowIndex === hash)! },
          f.source,
        ),
      ];
    }),
  );
  f.document = {
    version: 1,
    scope: f.scope,
    baseline: f.baseline,
    categories: {
      [category.id]: {
        id: category.id,
        name: category.name,
        rule: category.rule,
        active: true,
        count: entries.length,
        hashes: entries.map((e) => e.hash),
        comment: '',
        references,
      },
    },
  };
  const record = f.document.categories[category.id];
  const decide = () =>
    guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    )[0].entries.find((d) => d.hash === 102);
  return { ...f, record, decide };
}

it.each([false, true])(
  'extends exact names across three element tabs, including Prismatic (fragment: %s)',
  (fragment) => {
    const f = siblingFixture(fragment);
    expect(f.decide()).toMatchObject({
      action: 'link',
      confidence: 'high',
      ruleId: 'exact-name-in-sibling-element-tab',
      link: { gid: '1870531554', rowKey: 'Sample 102' },
    });
  },
);

it('requires three distinct usable positive element tabs', () => {
  const f = siblingFixture();
  delete f.record.references![103];
  expect(f.decide()).toMatchObject({ confidence: 'medium', ruleId: 'uncovered-element-tab' });
  const entry = f.categories[0].entries.find((e) => e.hash === 104)!;
  const tab = f.source.tabs[0];
  f.record.references![104] = sampleReference(
    entry,
    f.record.id,
    f.baseline,
    '',
    'accepted',
    { tab, row: tab.rows.find((r) => r.rowIndex === 104)! },
    f.source,
  );
  expect(f.decide()).toMatchObject({ confidence: 'medium', ruleId: 'uncovered-element-tab' });
});

it.each(['stale', 'negative', 'skipped', 'renamed', 'selected', 'multipart'] as const)(
  'does not learn the third tab from a %s reference',
  (kind) => {
    const f = siblingFixture();
    const ref = f.record.references![103];
    if (kind === 'stale') ref.evidence = 'changed';
    if (kind === 'negative' || kind === 'skipped') {
      ref.decision = kind === 'negative' ? 'no-equivalent' : 'skipped';
      delete ref.link;
    }
    if (kind === 'renamed') {
      // A valid picked source with a different name may teach its own tab, not siblings.
      const tab = f.source.tabs[2],
        row = tab.rows[0];
      row.name = 'Different source';
      row.nameNorm = 'different source';
      f.record.references![103] = sampleReference(
        f.categories[0].entries.find((e) => e.hash === 103)!,
        f.record.id,
        f.baseline,
        '',
        'picked',
        { tab, row },
        f.source,
      );
    }
    if (kind === 'selected') ref.link!.cells = [{ dRow: 0, dCol: 2 }];
    if (kind === 'multipart') ref.link!.parts = ['One', 'Two'];
    expect(f.decide()?.confidence).not.toBe('high');
  },
);

it('preserves an explicit owner negative and frozen membership', () => {
  const f = siblingFixture();
  f.record.references![102] = sampleReference(
    f.categories[0].entries.find((e) => e.hash === 102)!,
    f.record.id,
    f.baseline,
    '',
    'no-equivalent',
  );
  expect(f.decide()).toMatchObject({ action: 'no-equivalent', ruleId: 'explicit-owner' });
  delete f.record.references![102];
  f.record.hashes = f.record.hashes.filter((h) => h !== 102);
  expect(f.decide()).toBeUndefined();
});

it('withholds duplicate exact names, non-exact names, and unconfigured tabs', () => {
  const f = siblingFixture(),
    tab = f.source.tabs[3],
    row = tab.rows[0];
  tab.rows.push({
    ...row,
    rowIndex: 999,
    cell: { plain: 'Other body', runs: [{ text: 'Other body' }] },
  });
  expect(f.decide()?.confidence).not.toBe('high');
  tab.rows.pop();
  row.name = 'Sample 102 changed';
  row.nameNorm = 'sample 102 changed';
  expect(f.decide()?.confidence).not.toBe('high');
  row.name = 'Sample 102';
  row.nameNorm = 'sample 102';
  tab.gid = '1662574278';
  tab.name = 'Weapon Perks';
  expect(f.decide()).toMatchObject({ confidence: 'medium', ruleId: 'uncovered-element-tab' });
});

it('retains baseline, owner-sample, and source-evidence gates', () => {
  const f = siblingFixture();
  f.document.baseline = 'stale';
  expect(f.decide()?.confidence).not.toBe('high');
  f.document.baseline = f.baseline;
  f.record.references![102] = sampleReference(
    f.categories[0].entries.find((e) => e.hash === 102)!,
    f.record.id,
    f.baseline,
    '',
    'skipped',
  );
  expect(f.decide()?.confidence).not.toBe('high');
  delete f.record.references![102];
  f.source.tabs[2].rows[0].cell = { plain: 'Changed source', runs: [{ text: 'Changed source' }] };
  expect(f.decide()).toMatchObject({ confidence: 'medium', ruleId: 'uncovered-element-tab' });
});
