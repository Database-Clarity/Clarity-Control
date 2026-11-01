import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions, guidedRevision } from './guidedDecisions';
import { GuidedPreview } from './GuidedPreview';

it('proposes exact validated links with two references, exposes complete evidence, and never mutates inputs', () => {
  const f = guidedFixture();
  const before = JSON.stringify([f.document, f.categories, [...f.proposals], f.source]);
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.high).toBe(4);
  expect(group.unresolved).toBe(2);
  expect(group.entries.find((entry) => entry.hash === 102)).toMatchObject({
    action: 'link',
    confidence: 'high',
    references: [100, 101],
    link: { rowKey: 'Sample 102' },
  });
  expect(group.entries.find((entry) => entry.hash === 104)?.action).toBe('owner');
  expect(group.samples).toContain(103);
  expect(before).toBe(JSON.stringify([f.document, f.categories, [...f.proposals], f.source]));
  expect(guidedRevision([group])).toBe(
    guidedRevision(
      guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope),
    ),
  );
});

it('withholds changed baseline, scope and individual source/entry evidence', () => {
  for (const change of ['baseline', 'scope', 'source', 'entry'] as const) {
    const f = guidedFixture();
    if (change === 'baseline') f.baseline += 'changed';
    if (change === 'scope') f.scope += 'changed';
    if (change === 'source')
      f.source.tabs[0].rows[0].cell = { plain: 'Changed', runs: [{ text: 'Changed' }] };
    if (change === 'entry') f.categories[0].entries[0].sampleEvidence += 'changed';
    const [group] = guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    );
    expect(group.issues.length).toBeGreaterThan(0);
    expect(group.entries[0].confidence).toBe('unresolved');
    expect(group.entries[2].confidence).toBe('unresolved');
  }
});

it('never generalizes no-equivalent, skipped, note-only, comments, selected cells or renamed picks', () => {
  for (const kind of ['none', 'skip', 'note', 'comment', 'rename', 'cells'] as const) {
    const f = guidedFixture();
    const record = f.document.categories[f.categories[0].id];
    const reference = record.references![100];
    if (kind === 'none' || kind === 'skip' || kind === 'note') {
      reference.decision =
        kind === 'none' ? 'no-equivalent' : kind === 'skip' ? 'skipped' : undefined;
      delete reference.link;
    }
    if (kind === 'comment') record.comment = 'Need manual interpretation';
    if (kind === 'rename') reference.sourceName = 'Different name';
    if (kind === 'cells') reference.link!.cells = [{ dRow: 0, dCol: 2 }];
    const [group] = guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    );
    expect(group.entries[2].confidence).toBe('unresolved');
    if (kind === 'skip' || kind === 'note') expect(group.entries[0].action).toBe('owner');
  }
});

it('preserves human overrides and excludes new membership; missing references are explicit', () => {
  const f = guidedFixture();
  f.categories[0].entries[2].status = 'no-equivalent';
  f.document.categories[f.categories[0].id].hashes = [100, 101, 102, 999];
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries.map((entry) => entry.hash)).toEqual([100, 101, 102, 999]);
  expect(group.entries[2].action).toBe('preserve');
  expect(group.entries[3].reason).toContain('missing');
  expect(group.issues.some((issue) => issue.includes('new entries excluded'))).toBe(true);
  f.categories[0].entries = [];
  expect(
    guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    )[0].issues.join(),
  ).toContain('Reference 100');
});

it('withholds fuzzy proposals and makes preview-only scope and spot-check limitations visible', () => {
  const f = guidedFixture();
  f.proposals.get(102)!.link = undefined;
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[2].confidence).toBe('unresolved');
  const html = renderToStaticMarkup(
    createElement(GuidedPreview, { ...f, category: f.categories[0] }),
  );
  expect(html).toContain('6 recorded entries');
  expect(html).toContain('not individual review');
  expect(html).toContain('No drafts or category approval');
  expect(html).not.toContain('Accept category');
});
