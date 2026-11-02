import {
  resolveCompendiumLink,
  normaliseCompendiumName,
  normaliseRuns,
  sameCell,
  type CompendiumData,
  type CompendiumMatch,
} from '@clarity/core';
import type { GuidanceReference } from './guidanceSchema';
import { categoryId, type ReviewSample } from './reviewCategories';
import { sourceFingerprint } from './reviewProgress';
import { confirmCompendiumSelection } from './selection';

export function sampleReference(
  entry: ReviewSample,
  categoryId: string,
  baseline: string,
  note: string,
  decision?: GuidanceReference['decision'],
  match?: CompendiumMatch,
  source?: CompendiumData,
): GuidanceReference {
  const reference: GuidanceReference = {
    hash: entry.hash,
    name: entry.name,
    categoryId,
    evidence: entry.sampleEvidence,
    baseline,
    note,
    timestamp: new Date().toISOString(),
    decision,
  };
  if (decision === 'accepted' || decision === 'picked') {
    const link = match && source && confirmCompendiumSelection(match, source);
    if (!link || !match) throw new Error('Choose a uniquely resolvable source before accepting.');
    return {
      ...reference,
      link,
      sourceHash: sourceFingerprint([
        link.gid,
        link.rowKey,
        link.section,
        link.cells,
        link.snapshot,
      ]),
      sourceName: match.row.name,
      sourceTab: match.tab.name,
      sourceRow: match.row.rowIndex,
    };
  }
  return reference;
}

export function referenceCurrent(
  reference: GuidanceReference | undefined,
  entry: ReviewSample,
  baseline: string,
  source: CompendiumData,
) {
  if (
    !reference ||
    reference.hash !== entry.hash ||
    reference.categoryId !== categoryId(entry.category) ||
    reference.evidence !== entry.sampleEvidence ||
    reference.baseline !== baseline
  )
    return false;
  if (!reference.link) return true;
  return !!currentReferenceLink(reference, source);
}

// A formatter-only change must not invalidate an approval of unchanged source
// bodies. Replay the previously saved labels against current complete rows, and
// require BOTH the old source hash and exact styled snapshot to agree.
export function currentReferenceLink(reference: GuidanceReference, source: CompendiumData) {
  if (!reference.link) return;
  const resolved = resolveCompendiumLink(reference.link, source);
  if (!('row' in resolved)) return;
  const confirmed = confirmCompendiumSelection(resolved, source);
  if (!confirmed) return;
  const link = { ...confirmed, snapshotAt: reference.link.snapshotAt };
  const fingerprint = (candidate: typeof link) =>
    sourceFingerprint([
      candidate.gid,
      candidate.rowKey,
      candidate.section,
      candidate.cells,
      candidate.snapshot,
    ]);
  if (fingerprint(link) === reference.sourceHash) return link;
  const old = reference.link;
  if (old.cells || !old.parts?.length || fingerprint(old) !== reference.sourceHash) return;
  const rows = source.tabs
    .filter((tab) => tab.gid === old.gid)
    .flatMap((tab) => tab.rows)
    .filter((row) => row.nameNorm === normaliseCompendiumName(old.rowKey))
    .sort((a, b) => a.rowIndex - b.rowIndex || (a.anchor?.col ?? 0) - (b.anchor?.col ?? 0));
  if (rows.length !== old.parts.length) return;
  const replay = normaliseRuns(
    rows.flatMap((row, index) => [
      ...(index ? [{ text: '\n\n' }] : []),
      { text: `${old.parts![index]}\n`, bold: true },
      ...row.cell.runs,
    ]),
  );
  return sameCell(replay, old.snapshot) ? link : undefined;
}
