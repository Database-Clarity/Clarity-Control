import {
  combineCompendiumMatches,
  normaliseCompendiumName,
  sameCell,
  type CompendiumData,
} from '@clarity/core';
import records from './owner-reviewed.json';
import { confirmCompendiumSelection } from './selection';
import { emptyProgress, localDecision, sourceFingerprint } from './reviewProgress';
import type { ReviewSample } from './reviewCategories';
import type { ReviewProposal } from './rapidReview';
import type { GuidedDecision } from './guidedDecisions';

const tentative = new Map(records.noEquivalent.map((record) => [record.hash, record]));
const progress = {
  ...emptyProgress(),
  decisions: Object.fromEntries(
    records.noEquivalent.map((record) => [
      record.hash,
      {
        kind: 'no-equivalent' as const,
        fingerprint: sourceFingerprint([records.sourceFingerprint, record.entryEvidence]),
      },
    ]),
  ),
};

// Same fingerprint reopening as local review decisions. An unrelated sheet edit
// conservatively reopens the whole tentative set; entry evidence changes also reopen.
export function tentativeOwnerDecision(entry: ReviewSample, sheetFingerprint: string) {
  const record = tentative.get(entry.hash);
  return (
    record?.name === entry.name &&
    record.categoryId === `catalog:${entry.category}` &&
    localDecision(
      progress,
      entry.hash,
      sourceFingerprint([sheetFingerprint, entry.sampleEvidence]),
    ) === 'no-equivalent'
  );
}
export function reviewedOwnerDecision(
  entry: ReviewSample,
  proposal: ReviewProposal | undefined,
  source: CompendiumData,
): Partial<GuidedDecision> | undefined {
  const record = (records.verified as Record<string, (typeof records.verified)['4194622039']>)[
    entry.hash
  ];
  if (!record || record.name !== entry.name || record.categoryId !== `catalog:${entry.category}`)
    return;
  const stale: Partial<GuidedDecision> = {
    action: 'owner',
    confidence: 'unresolved',
    ruleId: 'owner-reviewed-evidence-changed',
    reason: 'Reviewed item/source cells changed or core no longer agrees; verify again.',
  };
  if (entry.sampleEvidence !== record.entryEvidence) return stale;
  const tab = source.tabs.find((t) => t.gid === record.gid);
  const rows =
    tab?.rows.filter(
      (row) => row.nameNorm === normaliseCompendiumName(record.rows[0]?.name ?? entry.name),
    ) ?? [];
  const match = tab && combineCompendiumMatches(rows.map((row) => ({ tab, row })));
  const expected = record.mode === 'armor' ? record.rows.slice(0, 1) : record.rows;
  const actual = record.mode === 'armor' && match && !match.parts ? [match.row] : rows;
  if (
    !match ||
    (record.mode === 'multi' && JSON.stringify(record.parts) !== JSON.stringify(match.parts)) ||
    actual.length !== expected.length ||
    actual.some((row, index) => {
      const proof = expected[index];
      return (
        row.name !== proof.name ||
        row.rowIndex !== proof.rowIndex ||
        row.anchor?.col !== proof.anchor.col ||
        sourceFingerprint(row.cell) !== proof.cellEvidence
      );
    }) ||
    !proposal?.link ||
    proposal.link.gid !== record.gid ||
    !(
      sameCell(proposal.link.snapshot, match.row.cell) ||
      (record.mode === 'multi' && rows.some((row) => sameCell(proposal.link!.snapshot, row.cell)))
    ) ||
    (record.mode !== 'multi' &&
      JSON.stringify(proposal.link.parts ?? []) !== JSON.stringify(match.parts ?? []))
  )
    return stale;
  const link = confirmCompendiumSelection(match, source);
  return link
    ? {
        action: 'link',
        confidence: 'high',
        link: { ...link, snapshotAt: source.fetchedAt },
        ruleId:
          record.mode === 'armor'
            ? 'exotic-armor-card'
            : record.mode === 'multi'
              ? 'owner-verified-multirow'
              : 'owner-verified-cell',
        reason: `Individually verified: ${record.meaning}`,
      }
    : stale;
}
