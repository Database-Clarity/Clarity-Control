import {
  normaliseCompendiumEnglish,
  resolveCompendiumLink,
  normaliseCompendiumName,
  normaliseRuns,
  sameCell,
  type CompendiumData,
  type CompendiumMatch,
} from '@clarity/core';
import type { GuidanceReference } from './guidanceSchema';
import { categoryId, type ReviewSample } from './reviewCategories';
import { rawFingerprint, sourceFingerprint } from './reviewProgress';
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
    !(reference.evidence === entry.sampleEvidence || legacyEntryCurrent(reference, entry)) ||
    reference.baseline !== baseline
  )
    return false;
  if (!reference.link) return true;
  return !!currentReferenceLink(reference, source);
}

// Reconstruct the old nested evidence from CURRENT editor/catalog data. Only positive
// selections may ignore unrelated sheet edits, and their saved styled source must replay.
function legacyEntryCurrent(reference: GuidanceReference, entry: ReviewSample) {
  if (!reference.link || entry.evidenceManifest === undefined) return false;
  if (
    entry.sampleEvidence !==
    sourceFingerprint([
      entry.hash,
      entry.evidence,
      ...(entry.next.custom?.categoryId === 'attachment-effect'
        ? [entry.next.custom.categoryId]
        : []),
      entry.evidenceManifest,
    ])
  )
    return false;
  const sheet = reference.baseline.slice(reference.baseline.lastIndexOf('|') + 1);
  const english = entry.base.text.en;
  const normalized = english && { ...english, text: normaliseCompendiumEnglish(english.text) };
  // Replay both historical nested proofs and newer raw-English approvals against
  // current editor/catalog data. Selected source evidence is still validated below.
  return [rawFingerprint, sourceFingerprint].some((hash) =>
    [english, normalized].some((text) => {
      const evidence = hash([sheet, entry.name, entry.category, text, entry.base.compendium]);
      return (
        reference.evidence ===
        hash([
          entry.hash,
          evidence,
          ...(entry.next.custom?.categoryId === 'attachment-effect'
            ? [entry.next.custom.categoryId]
            : []),
          entry.evidenceManifest,
        ])
      );
    }),
  );
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
  const fingerprint = (candidate: typeof link, legacy = false) =>
    (legacy ? rawFingerprint : sourceFingerprint)([
      candidate.gid,
      candidate.rowKey,
      candidate.section,
      candidate.cells,
      candidate.snapshot,
    ]);
  const old = reference.link;
  if (old.setBonusPieces !== link.setBonusPieces) return;
  // Validate the saved proof itself, then compare normalized current content and structure.
  const proven =
    fingerprint(old) === reference.sourceHash || fingerprint(old, true) === reference.sourceHash;
  if (!proven) return;
  if (fingerprint(link) === fingerprint(old)) return link;
  if (old.cells || !old.parts?.length) return;
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
