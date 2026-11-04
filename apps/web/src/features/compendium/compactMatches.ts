import type { CompendiumMatch, CompendiumSheet, Tooltip } from '@clarity/core';
import type { ReviewProposal } from './rapidReview';
import type { displayMatches } from './displayMatches';

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

/** The UI owns translations and draft baselines; review evidence needs English only. */
export function compactDisplay(result: ReturnType<typeof displayMatches>) {
  const tooltips = new WeakMap<Tooltip, Tooltip>();
  function tooltip(value: Tooltip) {
    let compact = tooltips.get(value);
    if (!compact) {
      compact = Object.keys(value.text).some((language) => language !== 'en')
        ? { ...value, text: value.text.en ? { en: value.text.en } : {} }
        : value;
      tooltips.set(value, compact);
    }
    return compact;
  }
  function entry<T extends { base: Tooltip; next: Tooltip }>(value: T): T {
    const base = tooltip(value.base),
      next = tooltip(value.next);
    return base === value.base && next === value.next ? value : { ...value, base, next };
  }
  return {
    ...result,
    matches: new Map([...result.matches].map(([hash, match]) => [hash, compactMatch(match)])),
    evidence: result.evidence.map(entry),
    categories: result.categories.map((category) => ({
      ...category,
      entries: category.entries.map(entry),
      samples: category.samples.map(entry),
      reasons: Object.fromEntries(
        Object.entries(category.reasons).map(([reason, entries]) => [reason, entries.map(entry)]),
      ) as typeof category.reasons,
    })),
  };
}
