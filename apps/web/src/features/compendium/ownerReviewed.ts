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
  const renewed = (records.reapproved as Record<string, (typeof records.reapproved)['4019266109']>)[
    entry.hash
  ];
  if (renewed) {
    const tab = source.tabs.find((tab) => tab.gid === renewed.gid);
    const rows =
      tab?.rows.filter(
        (row) => row.name === renewed.name && sourceFingerprint(row.cell) === renewed.cellEvidence,
      ) ?? [];
    // Keep the named card identity, and pin the explicit duplicate-card selection.
    const bodies =
      tab?.grid?.filter((cell) => sourceFingerprint(cell.cell) === renewed.cellEvidence) ?? [];
    const body = bodies[0];
    const link =
      entry.name === renewed.name &&
      `catalog:${entry.category}` === renewed.categoryId &&
      rows.length === 1 &&
      rows[0].anchor &&
      bodies.length === 1 &&
      tab &&
      body &&
      confirmCompendiumSelection(
        {
          tab,
          row: {
            ...rows[0],
            cell: body.cell,
          },
          sourceAnchor: rows[0].anchor,
          cells: [{ dRow: body.row - rows[0].anchor!.row, dCol: body.col - rows[0].anchor!.col }],
        },
        source,
      );
    return {
      action: link ? 'link' : 'owner',
      confidence: link ? 'high' : 'unresolved',
      ruleId: 'owner-reapproved-collective',
      link: link ? { ...link, snapshotAt: source.fetchedAt } : undefined,
      reason: link
        ? `${renewed.reviewedAt}: ${renewed.quote} (${renewed.decisionPage}); link approval only.`
        : 'Re-approved Collective identity or styled source changed; verify again.',
    };
  }
  const record = (records.verified as Record<string, (typeof records.verified)['4194622039']>)[
    entry.hash
  ];
  if (!record) return;
  const stale: Partial<GuidedDecision> = {
    action: 'owner',
    confidence: 'unresolved',
    ruleId: 'owner-reviewed-evidence-changed',
    reason: 'Reviewed item/source cells changed or core no longer agrees; verify again.',
  };
  // Explicit identity approval is independent of global sheet coordinates and
  // authored text. Current hash/name/category, complete styled source set and
  // core agreement must still validate; tentative negatives use stricter fingerprints.
  if (record.name !== entry.name || record.categoryId !== `catalog:${entry.category}`) return stale;
  const tab = source.tabs.find((t) => t.gid === record.gid);
  const rows =
    tab?.rows.filter(
      (row) => row.nameNorm === normaliseCompendiumName(record.rows[0]?.name ?? entry.name),
    ) ?? [];
  const match = tab && combineCompendiumMatches(rows.map((row) => ({ tab, row })));
  const expected = record.mode === 'armor' ? record.rows.slice(0, 1) : record.rows;
  const actual = record.mode === 'armor' && match && !match.parts ? [match.row] : rows;
  // Parser suppression may remove repeated row-spanned names. The surviving
  // physical card must still contain the exact approved styled body; every saved
  // duplicate proof must describe that same body, never a different card.
  if (
    record.mode === 'armor' &&
    (record.rows.some(
      (proof) => proof.name !== expected[0].name || proof.cellEvidence !== expected[0].cellEvidence,
    ) ||
      (rows.length === 1 &&
        !tab?.grid?.some(
          (cell) =>
            cell.col === (rows[0].anchor?.col ?? -2) + 2 &&
            cell.row <= rows[0].rowIndex &&
            record.rows.every(
              (proof) =>
                cell.row + (cell.rowSpan ?? 1) >
                rows[0].rowIndex + proof.rowIndex - record.rows[0].rowIndex,
            ) &&
            sameCell(cell.cell, rows[0].cell),
        )))
  )
    return stale;
  const remaining = [...expected];
  if (
    !match ||
    actual.length !== expected.length ||
    actual.some((row) => {
      const index = remaining.findIndex(
        (proof) => row.name === proof.name && sourceFingerprint(row.cell) === proof.cellEvidence,
      );
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
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
        ruleId: record.ruleId,
        reason: `Individually verified: ${record.meaning}`,
      }
    : stale;
}
