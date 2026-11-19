import {
  normaliseCompendiumEnglish,
  normaliseEvidenceText,
  resolveAlias,
  resolveCompendiumLink,
  normaliseCompendiumName,
  normaliseRuns,
  sameCell,
  type Aliases,
  type CompendiumData,
  type CompendiumMatch,
} from '@clarity/core';
import type { GuidanceReference } from './guidanceSchema';
import { categoryId, type ReviewSample } from './reviewCategories';
import { evidenceFingerprint, rawFingerprint, sourceFingerprint } from './reviewProgress';
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

/** Whether a reference describes this entry: its own hash, or an alias-group member's group. */
function referenceIdentity(
  reference: GuidanceReference,
  entry: ReviewSample,
  aliases?: Aliases,
) {
  return (
    reference.hash === entry.hash ||
    (aliases !== undefined && resolveAlias(reference.hash, aliases) === entry.hash)
  );
}

/** The owner/catalog evidence a reference recorded, against current data only (no source cells). */
export function referenceEvidenceCurrent(
  reference: GuidanceReference | undefined,
  entry: ReviewSample,
  baseline: string,
  aliases?: Aliases,
) {
  if (
    !reference ||
    !referenceIdentity(reference, entry, aliases) ||
    reference.categoryId !== categoryId(entry.category) ||
    !(reference.evidence === entry.sampleEvidence || legacyEntryCurrent(reference, entry)) ||
    reference.baseline !== baseline
  )
    return false;
  return true;
}

export function referenceCurrent(
  reference: GuidanceReference | undefined,
  entry: ReviewSample,
  baseline: string,
  source: CompendiumData,
  aliases?: Aliases,
) {
  if (!referenceEvidenceCurrent(reference, entry, baseline, aliases)) return false;
  if (!reference?.link) return true;
  return !!currentReferenceLink(reference, source);
}

/** The saved tab a positive reference still demonstrates, though its cells may have changed. */
export function referenceSourceTab(reference: GuidanceReference, source: CompendiumData) {
  if (!reference.link) return;
  const resolved = resolveCompendiumLink(reference.link, source);
  if (!('row' in resolved) || resolved.tab.gid !== reference.link.gid) return;
  return resolved.tab.gid;
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
      referenceManifest(entry, entry.hash),
    ])
  )
    return false;
  const sheet = reference.baseline.slice(reference.baseline.lastIndexOf('|') + 1);
  const english = entry.base.text.en;
  const normalized = english && { ...english, text: normaliseCompendiumEnglish(english.text) };
  const formatted = english && { ...english, text: normaliseEvidenceText(english.text) };
  // An alias-group member's approval keeps its own identity inside the fingerprint, and its
  // manifest facts are the member's, not the group canonical's.
  const manifest = referenceManifest(entry, reference.hash);
  const manifests = entry.evidenceManifest === manifest ? [manifest] : [entry.evidenceManifest, manifest];
  // Replay historical nested proofs, newer raw-English approvals, and shared formatting
  // equivalence against current editor/catalog data. Selected source evidence is still
  // validated by the caller.
  return [rawFingerprint, sourceFingerprint].some((hash) =>
    [english, normalized, formatted].some((text) =>
      manifests.some((items) => {
        const evidence = hash([sheet, entry.name, entry.category, text, entry.base.compendium]);
        return (
          reference.evidence ===
          hash([
            reference.hash,
            evidence,
            ...(entry.next.custom?.categoryId === 'attachment-effect'
              ? [entry.next.custom.categoryId]
              : []),
            items,
          ])
        );
      }),
    ),
  );
}

/** The manifest facts recorded for one identity; a group's other members are not its content. */
function referenceManifest(entry: ReviewSample, hash: number) {
  const manifest = entry.evidenceManifest;
  if (!Array.isArray(manifest)) return manifest;
  const own = manifest.filter(
    (item) => item && typeof item === 'object' && (item as { hash?: number }).hash === hash,
  );
  return own.length ? own : manifest;
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
    sourceFingerprint([candidate.gid, candidate.rowKey, candidate.section, candidate.cells, candidate.snapshot]);
  const old = reference.link;
  if (old.setBonusPieces !== link.setBonusPieces) return;
  // Validate the saved proof itself (accepting proofs written by earlier normalisations), then
  // compare current content and structure with the shared formatting equivalence.
  const proven =
    !!reference.sourceHash &&
    [
      fingerprint(old),
      evidenceFingerprint([old.gid, old.rowKey, old.section, old.cells, old.snapshot]),
      rawFingerprint([old.gid, old.rowKey, old.section, old.cells, old.snapshot]),
    ].includes(reference.sourceHash);
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
