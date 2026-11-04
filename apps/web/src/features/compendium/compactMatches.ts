import type { CompendiumMatch, CompendiumSheet } from '@clarity/core';
import type { ReviewProposal } from './rapidReview';

const tabs = new WeakMap<CompendiumSheet, CompendiumSheet>();
/** The UI already owns the source grid; replies carry locations and rich cells, not another grid. */
export function compactMatch<T extends CompendiumMatch>(match: T): T {
  if (!match.tab.grid && !match.tab.rows.length) return match;
  let tab = tabs.get(match.tab);
  if (!tab) {
    tab = { ...match.tab, rows: [], grid: undefined };
    tabs.set(match.tab, tab);
  }
  return { ...match, tab };
}

export function compactProposal(proposal: ReviewProposal): ReviewProposal {
  return {
    ...proposal,
    match: proposal.match && compactMatch(proposal.match),
    candidates: proposal.candidates.map(compactMatch),
  };
}
