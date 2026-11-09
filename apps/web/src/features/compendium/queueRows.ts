import type { GuidedDecision } from './guidedDecisions';
import type { ReviewProposal } from './rapidReview';
import type { ReviewEntry } from './reviewCategories';

/**
 * What a Compendium-tab row needs from the user.
 * - proposal / candidates / none / changed: open work (the review queue)
 * - drafted / skipped: decided on this device
 * - not-needed: local "no equivalent" or out of scope by rule (re-includable)
 * - matched: a confident match shown automatically; not a queue row until `show=matched`
 */
export type QueueKind =
  | 'proposal'
  | 'candidates'
  | 'none'
  | 'changed'
  | 'drafted'
  | 'skipped'
  | 'not-needed'
  | 'matched';

export const openKinds: readonly QueueKind[] = ['proposal', 'candidates', 'none', 'changed'];
export const decidedKinds: readonly QueueKind[] = ['drafted', 'skipped'];

export interface QueueRow {
  hash: number;
  name: string;
  /** Catalog category id of the entry (editor.categories id), not the review group id. */
  category: string;
  kind: QueueKind;
  /** Why a not-needed row is excluded: a rule, or the user's own "no equivalent". */
  excluded?: 'rule' | 'local';
}

export interface QueueCounts {
  /** Open work: proposal, candidates, none, changed. */
  open: number;
  matched: number;
  notNeeded: number;
  decided: number;
}

export interface QueueInput {
  entries: readonly ReviewEntry[];
  decisions: ReadonlyMap<number, Pick<GuidedDecision, 'action' | 'confidence' | 'link'>>;
  proposals: ReadonlyMap<number, ReviewProposal>;
  /** Hashes the user re-included after they were excluded by rule. */
  restored: ReadonlySet<number>;
}

/**
 * One row per review entry. Local state wins over the shipped decision, so a draft or skip is
 * never hidden by a rule; a decision-less entry is `none` even when the resolver has a link
 * (the shipped approval, not the live resolver, defines "confident").
 */
export function deriveQueueRow(
  entry: ReviewEntry,
  decisions: QueueInput['decisions'],
  proposals: QueueInput['proposals'],
  restored: QueueInput['restored'],
): QueueRow | undefined {
  const row = (kind: QueueKind, excluded?: QueueRow['excluded']): QueueRow => ({
    hash: entry.hash,
    name: entry.name,
    category: entry.category,
    kind,
    ...(excluded ? { excluded } : {}),
  });
  if (entry.status === 'drafted') return row('drafted');
  if (entry.status === 'skipped') return row('skipped');
  if (entry.status === 'no-equivalent') return row('not-needed', 'local');
  if (entry.status === 'saved') return undefined;
  const decision = decisions.get(entry.hash);
  const proposal = proposals.get(entry.hash);
  const reincluded = restored.has(entry.hash);
  if (
    !reincluded &&
    decision &&
    (decision.action === 'out-of-scope' || decision.action === 'no-equivalent')
  )
    return row('not-needed', 'rule');
  if (entry.stale) return row('changed');
  if (!decision) return row('none');
  if (
    decision.action === 'preserve' ||
    (decision.action === 'link' &&
      (decision.confidence === 'high' || decision.confidence === 'out-of-scope'))
  )
    return row('matched');
  if (
    (decision.action === 'link' && decision.confidence === 'medium' && decision.link) ||
    ((decision.action === 'owner' || decision.action === 'out-of-scope') && proposal?.link)
  )
    return row('proposal');
  if (proposal?.candidates.length) return row('candidates');
  return row('none');
}

export function deriveQueueRows(input: QueueInput): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const entry of input.entries) {
    const row = deriveQueueRow(entry, input.decisions, input.proposals, input.restored);
    if (row) rows.push(row);
  }
  return rows;
}

export function queueCounts(rows: readonly QueueRow[]): QueueCounts {
  const counts: QueueCounts = { open: 0, matched: 0, notNeeded: 0, decided: 0 };
  for (const { kind } of rows) {
    if (openKinds.includes(kind)) counts.open++;
    else if (kind === 'matched') counts.matched++;
    else if (kind === 'not-needed') counts.notNeeded++;
    else counts.decided++;
  }
  return counts;
}

export const kindLabels: Record<QueueKind, string> = {
  proposal: 'Proposal',
  candidates: 'Candidates',
  none: 'No candidate',
  changed: 'Changed',
  drafted: 'Drafted',
  skipped: 'Skipped',
  'not-needed': 'Not needed',
  matched: 'Matched',
};
export const kindGlyphs: Record<QueueKind, string> = {
  proposal: '▸',
  candidates: '◇',
  none: '·',
  changed: '!',
  drafted: '✓',
  skipped: '–',
  'not-needed': '∅',
  matched: '=',
};

export const showOptions = [
  { value: 'open', label: 'Open' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'none', label: 'No candidate' },
  { value: 'changed', label: 'Changed' },
  { value: 'decided', label: 'Decided' },
  { value: 'matched', label: 'Matched' },
  { value: 'all', label: 'All' },
] as const;
export type ShowFilter = (typeof showOptions)[number]['value'];

export function parseShow(value: string | null): ShowFilter {
  return showOptions.find((option) => option.value === value)?.value ?? 'open';
}

/** Rows whose kind a `show` filter includes. Not-needed rows only appear in `all` (and their own group). */
export function showMatches(show: ShowFilter, kind: QueueKind): boolean {
  switch (show) {
    case 'open':
      return openKinds.includes(kind);
    case 'proposal':
      return kind === 'proposal';
    case 'none':
      return kind === 'none' || kind === 'candidates';
    case 'changed':
      return kind === 'changed';
    case 'decided':
      return decidedKinds.includes(kind);
    case 'matched':
      return kind === 'matched';
    case 'all':
      return true;
  }
}
