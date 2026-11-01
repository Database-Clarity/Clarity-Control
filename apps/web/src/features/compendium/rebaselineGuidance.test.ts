import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { rebaselineGuidance } from './rebaselineGuidance';
import { referenceCurrent } from './sampleReferences';

it('renews commit-only changes without mutating owner evidence, notes, timestamps or membership', () => {
  const f = guidedFixture();
  const before = JSON.stringify(f.document);
  const baseline = 'migrated|same-source';
  const result = rebaselineGuidance(f.document, f.categories, f.source, baseline, f.scope);
  expect(result.renewed).toHaveLength(5);
  expect(result.changed).toEqual([]);
  expect(JSON.stringify(f.document)).toBe(before);
  const copy = structuredClone(result.document);
  copy.baseline = f.baseline;
  for (const ref of Object.values(copy.categories[f.categories[0].id].references!))
    ref.baseline = f.baseline;
  expect(copy).toEqual(f.document);
  for (const entry of f.categories[0].entries) {
    const ref = result.document.categories[f.categories[0].id].references?.[entry.hash];
    if (ref) expect(referenceCurrent(ref, entry, baseline, f.source)).toBe(true);
  }
});

it('withholds changed English, manifest identity, selected source and absent membership', () => {
  for (const change of ['evidence', 'source', 'missing', 'membership'] as const) {
    const f = guidedFixture();
    if (change === 'evidence') f.categories[0].entries[0].sampleEvidence += 'changed';
    if (change === 'source')
      f.source.tabs[0].rows[0].cell = { plain: 'Changed', runs: [{ text: 'Changed' }] };
    if (change === 'missing')
      f.categories[0].entries = f.categories[0].entries.filter((entry) => entry.hash !== 100);
    if (change === 'membership') {
      f.document.categories[f.categories[0].id].hashes = [101, 102, 103, 104, 105];
      f.document.categories[f.categories[0].id].count = 5;
    }
    const result = rebaselineGuidance(f.document, f.categories, f.source, 'new', f.scope);
    expect(result.changed.map((ref) => ref.hash)).toEqual([100]);
    expect(result.document.categories[f.categories[0].id].references![100].baseline).toBe(
      f.baseline,
    );
  }
});

it('rejects scope changes and never adds newly discovered entries to recorded scope', () => {
  const f = guidedFixture();
  expect(() => rebaselineGuidance(f.document, f.categories, f.source, 'new', 'other')).toThrow(
    /dataset/,
  );
  f.document.categories[f.categories[0].id].hashes = [100];
  f.document.categories[f.categories[0].id].count = 1;
  f.document.categories[f.categories[0].id].references = {
    100: f.document.categories[f.categories[0].id].references![100],
  };
  expect(
    rebaselineGuidance(f.document, f.categories, f.source, 'new', f.scope).document.categories[
      f.categories[0].id
    ].hashes,
  ).toEqual([100]);
});
