import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assembleDrafts } from './assemble.mjs';
import { draftDigest, sampleInputDigest } from './fresh.mjs';
import { revisionDigest } from './revision.mjs';
import {
  editorDraftSchema,
  editorDraftIndexSchema,
} from '../../apps/web/src/services/editorDrafts.ts';

function fixture() {
  const item = {
    hash: 100,
    category: 'verbs',
    name: 'Verb',
    sourceCommit: 'a'.repeat(40),
    source: { tab: 'Arc', gid: '123', range: 'C2', text: 'Deals 12 damage.' },
  };
  const duplicate = { ...item, hash: 101, source: { ...item.source, range: 'C3' } };
  const input = { styleGuide: 'v4.12', guideKitSha256: 'kit', items: [item] };
  const drafts = { 100: 'Deals 12 damage.', _meta: { guideKitSha256: 'kit' } };
  const bytes = Buffer.from(JSON.stringify(drafts));
  const critique = {
    verdict: 'APPROVE',
    digestsReproduced: true,
    guideKitSha256: 'kit',
    draftDigest: draftDigest(drafts),
    revisionDigest: revisionDigest(drafts),
    inputDigest: sampleInputDigest(input),
    candidateSha256: createHash('sha256').update(bytes).digest('hex'),
    checksByHash: { 100: 'PASS' },
  };
  return {
    census: [item, duplicate],
    batches: [
      {
        input,
        bytes,
        critique,
        validation: { accepted: { 100: drafts[100] }, errors: {}, excluded: [] },
      },
    ],
    reuse: [{ hash: 101, from: 100 }],
    guideKitSha256: 'kit',
    styleGuide: 'v4.12',
    createdAt: '2026-11-15T00:00:00Z',
    model: 'gpt-6.1-sol',
    knownHashes: new Set([100, 101]),
    parseDraft: (value) => editorDraftSchema.parse(value),
    parseIndex: (value) => editorDraftIndexSchema.parse(value),
    validate: () => [],
  };
}
it('uses loader schemas and preserves each duplicate cell provenance', () => {
  const result = assembleDrafts(fixture());
  expect(result.index.hashes).toEqual([100, 101]);
  expect(result.drafts.map((d) => d.source.range)).toEqual(['C2', 'C3']);
  expect(result.drafts.map((d) => d.english)).toEqual(['Deals 12 damage.', 'Deals 12 damage.']);
});
it('inherits verified supplemental evidence for identical cells while retaining its own link', () => {
  const x = fixture(),
    proof = [{ fragment: 'Verified fragment', total: 4.5 }];
  x.census[0].fragmentImprovements = proof;
  x.census[0].ownerCorrections = ['Use the corrected value.'];
  x.batches[0].critique.inputDigest = sampleInputDigest(x.batches[0].input);
  const checked = [];
  x.validate = (item) => {
    checked.push(item);
    return item.fragmentImprovements === proof ? [] : ['Missing proof'];
  };
  const result = assembleDrafts(x),
    duplicate = checked.find((item) => item.hash === 101);
  expect(duplicate.fragmentImprovements).toBe(proof);
  expect(duplicate.ownerCorrections).toContain('Use the corrected value.');
  expect(result.drafts[1].source.range).toBe('C3');
});
it('rejects stale bytes, inputs, approvals, and per-row validation', () => {
  for (const mutate of [
    (x) => {
      x.batches[0].bytes = Buffer.from(x.batches[0].bytes + ' ');
    },
    (x) => {
      x.batches[0].input.items[0].source.text = 'Changed.';
    },
    (x) => {
      x.batches[0].critique.checksByHash[100] = 'FAIL';
    },
    (x) => {
      x.batches[0].validation.accepted[100] = 'Changed.';
    },
    (x) => {
      x.batches[0].critique.digestsReproduced = false;
    },
  ]) {
    const x = fixture();
    mutate(x);
    expect(() => assembleDrafts(x)).toThrow();
  }
});
it('rejects array-shaped warning metadata even when its bytes were reviewed', () => {
  const x = fixture(),
    batch = x.batches[0],
    drafts = JSON.parse(batch.bytes);
  drafts._meta.sourceWarnings = [{ hash: 100, warning: 'Uncertain.' }];
  batch.bytes = Buffer.from(JSON.stringify(drafts));
  batch.critique.draftDigest = draftDigest(drafts);
  batch.critique.revisionDigest = revisionDigest(drafts);
  batch.critique.candidateSha256 = createHash('sha256').update(batch.bytes).digest('hex');
  expect(() => assembleDrafts(x)).toThrow('Invalid source warning metadata');
});
it('rejects unknown hashes, divergent reuse, incomplete coverage, and stale sources', () => {
  for (const mutate of [
    (x) => x.knownHashes.delete(101),
    (x) => {
      x.census[1].source.text = 'Different.';
    },
    (x) => {
      x.reuse = [];
    },
    (x) => {
      x.census[1].name = 'Other';
    },
    (x) => {
      x.census[0] = { ...x.census[0], sourceCommit: 'b'.repeat(40) };
    },
  ]) {
    const x = fixture();
    mutate(x);
    expect(() => assembleDrafts(x)).toThrow();
  }
});
it('accounts for bounded exclusions and propagates them to proven duplicate cells', () => {
  const x = fixture(),
    b = x.batches[0],
    d = JSON.parse(b.bytes);
  d._meta.excluded = [{ hash: 100, reason: 'Unresolved scope' }];
  b.bytes = Buffer.from(JSON.stringify(d));
  b.critique.draftDigest = draftDigest(d);
  b.critique.revisionDigest = revisionDigest(d);
  b.critique.candidateSha256 = createHash('sha256').update(b.bytes).digest('hex');
  b.critique.checksByHash[100] = 'FAIL';
  b.validation = { accepted: {}, errors: {}, excluded: d._meta.excluded };
  const result = assembleDrafts(x);
  expect(result.index.hashes).toEqual([]);
  expect(result.excluded.map((e) => e.hash)).toEqual([100, 101]);
});
it('retains only explicit PASS rows of a final rejected candidate without changing its bytes', () => {
  const x = fixture(),
    batch = x.batches[0];
  batch.critique.verdict = 'REJECT';
  batch.critique.checksByHash[100] = 'FAIL';
  batch.postReviewExclusions = {
    repairAttempts: 1,
    rows: [{ hash: 100, reason: 'Failed after repair' }],
  };
  expect(assembleDrafts(x).excluded.map((row) => row.hash)).toEqual([100, 101]);
  batch.postReviewExclusions.repairAttempts = 0;
  expect(() => assembleDrafts(x)).toThrow('Invalid post-review exclusion evidence');
  batch.postReviewExclusions.repairAttempts = 1;
  batch.critique.checksByHash[100] = 'PASS';
  expect(() => assembleDrafts(x)).toThrow('Invalid post-review exclusion evidence');
});
