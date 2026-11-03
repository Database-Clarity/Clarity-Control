import { countConflicts, languages, type Lang, type Tooltip } from '@clarity/core';
import type { Drafts } from '../../services/draftStorage';

/** What is still open for one tooltip: marker blocks per language and non-text fields to choose. */
export interface ConflictSummary {
  hash: number;
  markers: number;
  byLanguage: Partial<Record<Lang, number>>;
  rows: number;
  total: number;
}

export function markersIn(tooltip: Tooltip): Partial<Record<Lang, number>> {
  const out: Partial<Record<Lang, number>> = {};
  for (const lang of languages) {
    const found = countConflicts(tooltip.text[lang]?.text ?? '');
    if (found > 0) out[lang] = found;
  }
  return out;
}

export function summarize(
  hash: number,
  draft: Tooltip | undefined,
  unresolvedRows: number,
): ConflictSummary {
  const byLanguage = draft ? markersIn(draft) : {};
  const markers = Object.values(byLanguage).reduce((sum, count) => sum + count, 0);
  return { hash, markers, byLanguage, rows: unresolvedRows, total: markers + unresolvedRows };
}

/** Every tooltip with something open, from the drafts and the sessions' unresolved rows. */
export function openConflicts(
  drafts: Drafts,
  unresolvedRows: Readonly<Record<number, number>>,
): ConflictSummary[] {
  const hashes = new Set<number>([
    ...Object.keys(drafts).map(Number),
    ...Object.keys(unresolvedRows).map(Number),
  ]);
  return [...hashes]
    .map((hash) => summarize(hash, drafts[hash]?.next, unresolvedRows[hash] ?? 0))
    .filter((summary) => summary.total > 0)
    .sort((a, b) => a.hash - b.hash);
}
