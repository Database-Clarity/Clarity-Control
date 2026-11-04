import type { Drafts } from '../../services/draftStorage';
import type { displayMatches } from './displayMatches';
import { applyReviewProgress, type reviewEvidence } from './reviewQueue';
import type { ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';

type Prepared = ReturnType<typeof displayMatches>;
type Evidence = ReturnType<typeof reviewEvidence>;
const projections = new WeakMap<Prepared, WeakMap<Drafts, Evidence>>();
const reviewed = new WeakMap<
  Evidence,
  { decisions: string; entries: ReturnType<typeof applyReviewProgress> }
>();
const proposals = new WeakMap<
  Prepared,
  WeakMap<Map<number, ReviewProposal>, Map<number, ReviewProposal>>
>();

// Data and draft objects are immutable. Retain the projection across workspace mounts,
// while always overlaying the actual current draft text rather than the worker's metadata copy.
export function preparedEvidence(prepared: Prepared, drafts: Drafts): Evidence {
  let byDrafts = projections.get(prepared);
  if (!byDrafts) projections.set(prepared, (byDrafts = new WeakMap()));
  const previous = byDrafts.get(drafts);
  if (previous) return previous;
  const evidence = prepared.evidence.map((entry) => {
    const next = drafts[entry.hash]?.next ?? entry.base;
    return next === entry.next ? entry : { ...entry, next };
  });
  byDrafts.set(drafts, evidence);
  return evidence;
}

export function reviewedEntries(evidence: Evidence, progress: ReviewProgress) {
  // Selection and filters do not affect entry evidence or local decisions.
  const decisions = JSON.stringify(progress.decisions);
  const previous = reviewed.get(evidence);
  if (previous?.decisions === decisions) return previous.entries;
  const entries = applyReviewProgress(evidence, progress);
  reviewed.set(evidence, { decisions, entries });
  return entries;
}

export function preparedProposals(prepared: Prepared, core: Map<number, ReviewProposal>) {
  let byCore = proposals.get(prepared);
  if (!byCore) proposals.set(prepared, (byCore = new WeakMap()));
  const previous = byCore.get(core);
  if (previous) return previous;
  const shown = new Map(core);
  const decisions = new Map(prepared.decisions.map((decision) => [decision.hash, decision]));
  for (const [hash, match] of prepared.matches) {
    shown.set(hash, {
      match,
      link: decisions.get(hash)?.link,
      candidates: shown.get(hash)?.candidates ?? [],
    });
  }
  byCore.set(core, shown);
  return shown;
}
