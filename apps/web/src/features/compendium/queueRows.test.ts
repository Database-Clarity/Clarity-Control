import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GuidedDecision } from './guidedDecisions';
import type { ReviewProposal } from './rapidReview';
import type { ReviewEntry } from './reviewCategories';
import { decodePrecomputed } from './precomputedCodec';
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
): QueueKind | undefined {
  return deriveQueueRow(
    e,
    new Map(d ? [[e.hash, d]] : []),
    new Map(p ? [[e.hash, p]] : []),
    new Set(restored),
  )?.kind;
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
    expect(kindOf(entry(1, { stale: true }), decision('link', 'high', link))).toBe('changed');
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

  it('re-including an excluded entry reopens it from its resolver state', () => {
    const rule = decision('out-of-scope', 'out-of-scope');
    expect(kindOf(entry(7), rule, proposal(false), [7])).toBe('none');
    expect(kindOf(entry(7), rule, proposal(true), [7])).toBe('proposal');
    expect(kindOf(entry(8), rule, proposal(true), [7])).toBe('not-needed');
  });

  it('marks why a not-needed row is excluded', () => {
    const rows = deriveQueueRows({
      entries: [entry(1, { status: 'no-equivalent' }), entry(2)],
      decisions: new Map([[2, decision('out-of-scope', 'out-of-scope')]]),
      proposals: new Map(),
      restored: new Set(),
    });
    expect(rows.map((row) => row.excluded)).toEqual(['local', 'rule']);
  });

  it('counts open, matched, not needed, and decided separately', () => {
    const rows = ['proposal', 'none', 'changed', 'drafted', 'skipped', 'matched', 'not-needed'].map(
      (kind, hash) => ({ hash, name: '', category: '', kind }) as never,
    );
    expect(queueCounts(rows)).toEqual({ open: 3, matched: 1, notNeeded: 1, decided: 2 });
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

describe('shipped precomputed census (design: 483 to review, 1,935 matched, 290 not needed)', () => {
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
    });
    expect(rows).toHaveLength(2708);
    const counts = queueCounts(rows);
    expect(counts).toMatchObject({ open: 483, matched: 1935, notNeeded: 290, decided: 0 });
    const byKind = Object.fromEntries(
      [...new Set(rows.map((row) => row.kind))].map((kind) => [
        kind,
        rows.filter((row) => row.kind === kind).length,
      ]),
    );
    expect(byKind).toMatchObject({ proposal: 255, candidates: 16, none: 212 });
  });
});
