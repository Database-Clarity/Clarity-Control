import type { GuidedDecision } from './guidedDecisions';
import type { ReviewProposal } from './rapidReview';
import type { ReviewEntry } from './reviewCategories';
import type { SharedDecisions } from './sharedDecisions';

/**
 * What a Compendium-tab row needs from the user.
 * - proposal / candidates / none: open work without a link (the review queue)
 * - changed: open work; a saved, drafted, or owner-approved link whose source changed
 * - drafted / skipped: decided on this device; a confident match ends a skip
 * - no-match: a maintainer's "no match yet"; ends by itself at a confident match
 * - not-needed: a maintainer's "not needed", or out of scope by rule (re-includable)
 * - matched: a confident match shown automatically; not a queue row until `show=matched`
 */
export type QueueKind =
  | 'proposal'
  | 'candidates'
  | 'none'
  | 'changed'
  | 'drafted'
  | 'skipped'
  | 'no-match'
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
  /** Why a not-needed row is excluded: a rule, a maintainer, or an earlier choice on this device. */
  excluded?: 'rule' | 'shared' | 'local';
  /** An earlier Not needed choice on this device whose entry has a confident match now. */
  matches?: true;
}

export interface QueueCounts {
  /** Open work: proposal, candidates, none, changed. */
  open: number;
  matched: number;
  noMatch: number;
  notNeeded: number;
  decided: number;
}

export interface QueueInput {
  entries: readonly ReviewEntry[];
  decisions: ReadonlyMap<number, Pick<GuidedDecision, 'action' | 'confidence' | 'link'>>;
  proposals: ReadonlyMap<number, ReviewProposal>;
  /** Hashes the user re-included after they were excluded by rule. */
  restored: ReadonlySet<number>;
  shared: SharedDecisions;
  /** Whether an owner-approved link's source is no longer as it was approved. */
  approvedChanged(entry: ReviewEntry): boolean;
}

/**
 * One row per review entry. A draft wins over everything, then a maintainer's decision, then this
 * device's skip, then the shipped decision; a decision-less entry is `none` even when the resolver
 * has a link (the shipped approval, not the live resolver, defines "confident").
 */
export function deriveQueueRow(
  entry: ReviewEntry,
  { decisions, proposals, restored, shared, approvedChanged }: Omit<QueueInput, 'entries'>,
): QueueRow | undefined {
  const row = (kind: QueueKind, excluded?: QueueRow['excluded']): QueueRow => ({
    hash: entry.hash,
    name: entry.name,
    category: entry.category,
    kind,
    ...(excluded ? { excluded } : {}),
  });
  if (entry.status === 'drafted') return row(entry.reason === 'Changed' ? 'changed' : 'drafted');
  if (entry.status === 'saved') return undefined;
  const decision = decisions.get(entry.hash);
  const confident =
    decision?.action === 'link' &&
    (decision.confidence === 'high' || decision.confidence === 'out-of-scope');
  const mark = shared.get(entry.hash)?.kind;
  if (mark === 'not-needed') return row('not-needed', 'shared');
  if (mark === 'no-match' && entry.reason === 'Unlinked' && !confident) return row('no-match');
  if (entry.status === 'skipped' && !confident) return row('skipped');
  if (entry.status === 'no-equivalent')
    return { ...row('not-needed', 'local'), ...(confident ? { matches: true } : {}) };
  if (entry.reason === 'Needs repair') return row('changed');
  const proposal = proposals.get(entry.hash);
  const reincluded = restored.has(entry.hash);
  if (
    !reincluded &&
    decision &&
    (decision.action === 'out-of-scope' || decision.action === 'no-equivalent')
  )
    return row('not-needed', 'rule');
  if (confident || decision?.action === 'preserve') return row('matched');
  if (approvedChanged(entry)) return row('changed');
  if (!decision) return row('none');
  if (
    (decision.action === 'link' && decision.confidence === 'medium' && decision.link) ||
    ((decision.action === 'owner' || decision.action === 'out-of-scope') && proposal?.link)
  )
    return row('proposal');
  if (proposal?.candidates.length) return row('candidates');
  return row('none');
}

export function deriveQueueRows({ entries, ...input }: QueueInput): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const entry of entries) {
    const row = deriveQueueRow(entry, input);
    if (row) rows.push(row);
  }
  return rows;
}

export function queueCounts(rows: readonly QueueRow[]): QueueCounts {
  const counts: QueueCounts = { open: 0, matched: 0, noMatch: 0, notNeeded: 0, decided: 0 };
  for (const { kind } of rows) {
    if (openKinds.includes(kind)) counts.open++;
    else if (kind === 'matched') counts.matched++;
    else if (kind === 'no-match') counts.noMatch++;
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
  'no-match': 'No match yet',
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
  'no-match': '∅',
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
  { value: 'no-match', label: 'No match yet' },
  { value: 'not-needed', label: 'Not needed' },
  { value: 'all', label: 'All' },
] as const;
export type ShowFilter = (typeof showOptions)[number]['value'];

export function parseShow(value: string | null): ShowFilter {
  return showOptions.find((option) => option.value === value)?.value ?? 'open';
}

/** Rows whose kind a `show` filter includes. The set-aside groups follow the list instead. */
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
    case 'no-match':
    case 'not-needed':
      return kind === show;
    case 'all':
      return true;
  }
}
