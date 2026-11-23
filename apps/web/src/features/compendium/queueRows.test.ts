import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GuidedDecision } from './guidedDecisions';
import type { ReviewProposal } from './rapidReview';
import type { ReviewEntry } from './reviewCategories';
import { decodePrecomputed } from './precomputedCodec';
import type { SharedKind } from './sharedDecisions';
import { applyReviewProgress } from './reviewQueue';
import { emptyProgress } from './reviewProgress';
import {
  deriveQueueRow,
  deriveQueueRows,
  parseShow,
  queueCounts,
  showMatches,
  type QueueKind,
} from './queueRows';

const entry = (hash: number, patch: Partial<ReviewEntry> = {}) =>
  ({
    hash,
    name: `Entry ${hash}`,
    category: 'weapon-perk',
    status: 'open',
    reason: 'Unlinked',
    stale: false,
    ...patch,
  }) as ReviewEntry;
const decision = (
  action: GuidedDecision['action'],
  confidence: GuidedDecision['confidence'],
  link?: object,
) => ({ action, confidence, link }) as Pick<GuidedDecision, 'action' | 'confidence' | 'link'>;
const link = { gid: '1' } as GuidedDecision['link'];
const proposal = (withLink: boolean, candidates = 0) =>
  ({
    link: withLink ? link : undefined,
    candidates: Array.from({ length: candidates }, () => ({})),
  }) as unknown as ReviewProposal;

function kindOf(
  e: ReviewEntry,
  d?: ReturnType<typeof decision>,
  p?: ReviewProposal,
  restored: number[] = [],
  shared?: SharedKind,
  approvedChanged = false,
): QueueKind | undefined {
  return deriveQueueRow(e, {
    decisions: new Map(d ? [[e.hash, d]] : []),
    proposals: new Map(p ? [[e.hash, p]] : []),
    restored: new Set(restored),
    shared: new Map(shared ? [[e.hash, { kind: shared }]] : []),
    approvedChanged: () => approvedChanged,
  })?.kind;
}

describe('queue row kinds', () => {
  it('derives one kind per state, local state first', () => {
    expect(kindOf(entry(1, { status: 'drafted' }), decision('link', 'medium', link))).toBe(
      'drafted',
    );
    expect(kindOf(entry(1, { status: 'skipped' }), decision('owner', 'unresolved'))).toBe(
      'skipped',
    );
    expect(kindOf(entry(1, { status: 'no-equivalent' }))).toBe('not-needed');
    expect(kindOf(entry(1, { status: 'saved' }))).toBeUndefined();
    expect(kindOf(entry(1), decision('out-of-scope', 'out-of-scope'))).toBe('not-needed');
    expect(kindOf(entry(1), decision('no-equivalent', 'high'))).toBe('not-needed');
    expect(kindOf(entry(1), decision('link', 'medium', link), proposal(false))).toBe('proposal');
    expect(kindOf(entry(1), decision('owner', 'unresolved'), proposal(true))).toBe('proposal');
    expect(kindOf(entry(1), decision('owner', 'unresolved'), proposal(false, 2))).toBe(
      'candidates',
    );
    expect(kindOf(entry(1), decision('owner', 'unresolved'), proposal(false))).toBe('none');
    expect(kindOf(entry(1), decision('link', 'high', link), proposal(true))).toBe('matched');
    expect(kindOf(entry(1), decision('link', 'out-of-scope', link))).toBe('matched');
    // Undecided stays a human decision even when the live resolver has a link.
    expect(kindOf(entry(1), undefined, proposal(true))).toBe('none');
  });

  it('calls an entry changed only when a link it has or the owner approved lost its source', () => {
    const owner = decision('owner', 'unresolved');
    const repair = entry(1, { reason: 'Needs repair' });
    expect(kindOf(repair, decision('preserve', 'unresolved'))).toBe('changed');
    expect(kindOf(entry(1, { status: 'drafted', reason: 'Changed' }))).toBe('changed');
    expect(kindOf(entry(1, { status: 'drafted', reason: 'Linked' }))).toBe('drafted');
    expect(kindOf(entry(1), owner, undefined, [], undefined, true)).toBe('changed');
    // An old decision about an entry that never had a link is no change of its source.
    expect(kindOf(entry(1, { stale: true }), owner)).toBe('none');
    // The matcher still proves the approval's source.
    expect(kindOf(entry(1), decision('link', 'high', link), undefined, [], undefined, true)).toBe(
      'matched',
    );
    expect(kindOf({ ...repair, status: 'skipped' })).toBe('skipped');
  });

  it('hides a maintainer decision for everyone, until a link or a confident match ends No match', () => {
    const open = decision('owner', 'unresolved');
    expect(kindOf(entry(1), open, proposal(true), [], 'not-needed')).toBe('not-needed');
    expect(kindOf(entry(1), open, proposal(true), [], 'no-match')).toBe('no-match');
    expect(kindOf(entry(1), undefined, undefined, [], 'no-match')).toBe('no-match');
    expect(kindOf(entry(1, { status: 'skipped' }), open, undefined, [], 'no-match')).toBe(
      'no-match',
    );
    const confident = decision('link', 'high', link);
    expect(kindOf(entry(1), confident, proposal(true), [], 'no-match')).toBe('matched');
    expect(kindOf(entry(1), confident, proposal(true), [], 'not-needed')).toBe('not-needed');
    expect(kindOf(entry(1, { reason: 'Needs repair' }), undefined, undefined, [], 'no-match')).toBe(
      'changed',
    );
    expect(kindOf(entry(1, { status: 'drafted' }), open, undefined, [], 'not-needed')).toBe(
      'drafted',
    );
  });

  it('re-including an excluded entry reopens it from its resolver state', () => {
    const rule = decision('out-of-scope', 'out-of-scope');
    expect(kindOf(entry(7), rule, proposal(false), [7])).toBe('none');
    expect(kindOf(entry(7), rule, proposal(true), [7])).toBe('proposal');
    expect(kindOf(entry(8), rule, proposal(true), [7])).toBe('not-needed');
  });

  it('marks why a not-needed row is excluded', () => {
    const rows = deriveQueueRows({
      entries: [entry(1, { status: 'no-equivalent' }), entry(2), entry(3)],
      decisions: new Map([[2, decision('out-of-scope', 'out-of-scope')]]),
      proposals: new Map(),
      restored: new Set(),
      shared: new Map([[3, { kind: 'not-needed' }]]),
      approvedChanged: () => false,
    });
    expect(rows.map((row) => row.excluded)).toEqual(['local', 'rule', 'shared']);
  });

  it('counts open, matched, no match, not needed, and decided separately', () => {
    const rows = [
      'proposal',
      'none',
      'changed',
      'drafted',
      'skipped',
      'matched',
      'no-match',
      'not-needed',
    ].map((kind, hash) => ({ hash, name: '', category: '', kind }) as never);
    expect(queueCounts(rows)).toEqual({
      open: 3,
      matched: 1,
      noMatch: 1,
      notNeeded: 1,
      decided: 2,
    });
  });
});

describe('show filter', () => {
  it('defaults unknown values to open and filters by kind', () => {
    expect(parseShow(null)).toBe('open');
    expect(parseShow('bogus')).toBe('open');
    expect(parseShow('all')).toBe('all');
    expect(showMatches('open', 'proposal')).toBe(true);
    expect(showMatches('open', 'drafted')).toBe(false);
    expect(showMatches('open', 'matched')).toBe(false);
    expect(showMatches('none', 'candidates')).toBe(true);
    expect(showMatches('decided', 'skipped')).toBe(true);
    expect(showMatches('matched', 'matched')).toBe(true);
  });
});

describe('shipped precomputed census (157 to review, 1,533 matched, 272 not needed; 2026-11-23 refresh)', () => {
  it('reproduces the design counts', () => {
    const file = new URL('./precomputed.v1.json', import.meta.url);
    const { nodes, root } = JSON.parse(readFileSync(file, 'utf8')) as {
      nodes: unknown[];
      root: number;
    };
    const value = decodePrecomputed(nodes, root) as {
      display: {
        decisions: (GuidedDecision & { hash: number })[];
        evidence: Parameters<typeof applyReviewProgress>[0];
        scopeHashes: number[];
      };
      proposals: [number, ReviewProposal][];
    };
    const entries = applyReviewProgress(value.display.evidence, emptyProgress());
    const rows = deriveQueueRows({
      entries,
      decisions: new Map(value.display.decisions.map((d) => [d.hash, d])),
      proposals: new Map(value.proposals),
      restored: new Set(),
      shared: new Map(),
      approvedChanged: () => false,
    });
    expect(rows).toHaveLength(1962);
    const counts = queueCounts(rows);
    expect(counts).toMatchObject({ open: 157, matched: 1533, notNeeded: 272, decided: 0 });
    expect(rows.find((row) => row.hash === 3291013836)).toMatchObject({
      name: 'Amplified',
      kind: 'matched',
    });
    expect(rows.find((row) => row.hash === 2724747993)).toMatchObject({
      name: 'Threadling',
      kind: 'matched',
    });
    const byKind = Object.fromEntries(
      [...new Set(rows.map((row) => row.kind))].map((kind) => [
        kind,
        rows.filter((row) => row.kind === kind).length,
      ]),
    );
    expect(byKind).toMatchObject({ proposal: 8, candidates: 11, none: 138 });
  });
});
