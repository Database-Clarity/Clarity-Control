import {
  resolveCompendiumLink,
  type CompendiumCandidate,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumMatch,
} from '@clarity/core';
import type { GuidedDecision } from './guidedDecisions';
import type { ReviewProposal } from './rapidReview';
import { confirmCompendiumSelection } from './selection';
import { suggestionAnchor, type CompendiumSuggestion } from './suggestions';
import { matchLocation, type SourceLocation } from './sourceLocation';

export interface CandidateBlock {
  id: string;
  origin: 'proposal' | 'candidate' | 'hint';
  match: CompendiumMatch;
  location: SourceLocation;
  /** The link Confirm drafts for this block; hints never carry one (navigation only). */
  link?: CompendiumLink;
  /** One muted line: the rule and score behind the block. */
  rule?: string;
  /** Hint rationale, shown on demand. */
  rationale?: string;
}

const maxCandidates = 3;
const maxHints = 2;

function sameRow(a: CompendiumMatch, b: CompendiumMatch) {
  return (
    a.tab.gid === b.tab.gid &&
    a.row.rowIndex === b.row.rowIndex &&
    a.row.anchor?.row === b.row.anchor?.row &&
    a.row.anchor?.col === b.row.anchor?.col
  );
}

function score(candidate: CompendiumMatch) {
  const similarity = (candidate as Partial<CompendiumCandidate>).similarity;
  return typeof similarity === 'number' ? `score ${similarity.toFixed(2)}` : undefined;
}

export interface BlockInput {
  decision?: Pick<GuidedDecision, 'action' | 'confidence' | 'link' | 'ruleId' | 'reason'>;
  proposal?: ReviewProposal;
  source: CompendiumData;
  hints: readonly CompendiumSuggestion[];
}

/**
 * The places an entry could link to, best first: the proposal, resolver candidates, then research
 * hints. A medium decision's own link beats the live resolver's, since the shipped approval is
 * what the owner reviewed.
 */
export function candidateBlocks({ decision, proposal, source, hints }: BlockInput): CandidateBlock[] {
  const blocks: CandidateBlock[] = [];
  const link =
    (decision?.action === 'link' ? decision.link : undefined) ?? proposal?.link ?? undefined;
  let proposed: CompendiumMatch | undefined;
  if (link) {
    const resolved = resolveCompendiumLink(link, source);
    if (['ok', 'changed', 'moved'].includes(resolved.status) && 'row' in resolved)
      proposed = resolved;
  }
  proposed ??= proposal?.match;
  if (proposed) {
    blocks.push({
      id: 'proposal',
      origin: 'proposal',
      match: proposed,
      location: matchLocation(proposed, source),
      link: link ?? confirmCompendiumSelection(proposed, source),
      // Only a medium decision's own rule explains its proposal; an unresolved owner decision
      // says why nothing was confirmed, and the live resolver is what proposed this row.
      rule:
        decision?.action === 'link'
          ? [decision.ruleId, decision.reason].filter(Boolean).join(' · ') || undefined
          : 'resolver proposal · confirm the scope',
    });
  }
  for (const candidate of proposal?.candidates ?? []) {
    if (blocks.length > maxCandidates) break;
    if (proposed && sameRow(candidate, proposed)) continue;
    blocks.push({
      id: `candidate:${blocks.length}`,
      origin: 'candidate',
      match: candidate,
      location: matchLocation(candidate, source),
      link: confirmCompendiumSelection(candidate, source),
      rule: score(candidate),
    });
  }
  let added = 0;
  for (const hint of hints) {
    if (added >= maxHints) break;
    const tab = source.tabs.find((candidate) => candidate.gid === hint.gid);
    const row = tab && suggestionAnchor(tab, hint);
    if (!tab || !row) continue;
    const match = { tab, row };
    if (blocks.some((block) => sameRow(block.match, match))) continue;
    added++;
    blocks.push({
      id: `hint:${added}`,
      origin: 'hint',
      match,
      location: matchLocation(match, source),
      rationale: hint.rationale,
      rule: hint.stale ? 'hint · source window changed' : 'research hint · navigation only',
    });
  }
  return blocks;
}
