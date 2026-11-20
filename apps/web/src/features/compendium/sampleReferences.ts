import {
  evidenceCell,
  normaliseCompendiumEnglish,
  normaliseEvidenceFormatting,
  normaliseCompendiumName,
  normaliseRuns,
  resolveCompendiumLink,
  sameCell,
  styleKey,
  type CompendiumCell,
  type CompendiumData,
  type CompendiumMatch,
  type CompendiumRow,
  type CompendiumSheet,
} from '@clarity/core';
import type { GuidanceReference } from './guidanceSchema';
import { categoryId, type ReviewSample } from './reviewCategories';
import { rawFingerprint, sourceFingerprint } from './reviewProgress';
import { confirmCompendiumSelection } from './selection';

/**
 * Same cell under presentation-only text folding. Run styles stay strict, so a colour,
 * bold or alignment change is never accepted as formatting churn.
 */
function sameFormattingCell(left: CompendiumCell, right: CompendiumCell) {
  if (normaliseEvidenceFormatting(left.plain) !== normaliseEvidenceFormatting(right.plain))
    return false;
  const a = evidenceCell(left);
  const b = evidenceCell(right);
  return (
    a.runs.length === b.runs.length &&
    a.runs.every(
      (run, index) =>
        styleKey(run) === styleKey(b.runs[index]) &&
        normaliseEvidenceFormatting(run.text) === normaliseEvidenceFormatting(b.runs[index].text),
    )
  );
}

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

/** The owner/catalog evidence a reference recorded, against current data only (no source cells). */
export function referenceEvidenceCurrent(reference: GuidanceReference, entry: ReviewSample) {
  return (
    reference.hash === entry.hash &&
    reference.categoryId === categoryId(entry.category) &&
    (reference.evidence === entry.sampleEvidence || legacyEntryCurrent(reference, entry))
  );
}

export function referenceCurrent(
  reference: GuidanceReference | undefined,
  entry: ReviewSample,
  baseline: string,
  source: CompendiumData,
) {
  if (!reference || reference.baseline !== baseline || !referenceEvidenceCurrent(reference, entry))
    return false;
  if (!reference.link) return true;
  return !!currentReferenceLink(reference, source);
}

/** The saved tab a positive reference still demonstrates, though its cells may have changed. */
export function referenceSourceTab(reference: GuidanceReference, source: CompendiumData) {
  const link = provenSourceLink(reference);
  if (!link) return;
  const resolved = resolveCompendiumLink(link, source);
  if (!('row' in resolved) || resolved.tab.gid !== link.gid) return;
  return resolved.tab.gid;
}

/**
 * Owner evidence recorded against an alias-group member belongs to the group: the member's
 * tooltip and source moved to the canonical, so the canonical entry inherits the reference
 * (root brief MATCHER-EVIDENCE, 2026-11-19; alias-group adoption 2026-11-17/18).
 *
 * A member's own sample evidence cannot be replayed once the group is adopted, so the saved
 * source proof is what must still hold. The per-reference baseline gate `referenceCurrent`
 * applies cannot hold either: the member's entry no longer exists at the new baseline, and
 * the document-level baseline gate (`compatible`) already covers the dataset. Only positive
 * references carry a source at all.
 */
export function groupReferenceCurrent(
  reference: GuidanceReference | undefined,
  entry: ReviewSample,
  source: CompendiumData,
) {
  if (!reference?.link || reference.categoryId !== categoryId(entry.category)) return false;
  return !!currentReferenceLink(reference, source);
}

// Reconstruct the old nested evidence from CURRENT editor/catalog data. Only positive
// selections may ignore unrelated sheet edits, and their saved styled source must replay.
function legacyEntryCurrent(reference: GuidanceReference, entry: ReviewSample) {
  if (entry.evidenceManifest === undefined) return false;
  const manifest = referenceManifest(entry, reference.hash);
  const prefix = (evidence: string) => [
    entry.hash,
    evidence,
    ...(entry.next.custom?.categoryId === 'attachment-effect'
      ? [entry.next.custom.categoryId]
      : []),
  ];
  const current = prefix(entry.evidence);
  if (entry.sampleEvidence !== sourceFingerprint([...current, manifest])) return false;
  // Negative and note-only records can replay the exact old grouped proof.
  if (reference.evidence === sourceFingerprint([...current, entry.evidenceManifest])) return true;
  if (!reference.link) return false;
  const sheet = reference.baseline.slice(reference.baseline.lastIndexOf('|') + 1);
  const english = entry.base.text.en;
  const normalized = english && { ...english, text: normaliseCompendiumEnglish(english.text) };
  // Presentation-only churn (parser markup forms, dashes, quotes, line breaks) replays as
  // its consumer-lowered text. Wording, numbers and symbols still differ.
  const formatting =
    english && english.text !== normaliseEvidenceFormatting(english.text)
      ? { ...english, text: normaliseEvidenceFormatting(english.text) }
      : undefined;
  // Replay historical nested proofs and newer raw-English approvals against current
  // editor/catalog data. Selected source evidence is still validated below.
  const manifests = [entry.evidenceManifest, manifest];
  return [rawFingerprint, sourceFingerprint].some((hash) =>
    [english, normalized, formatting].some((text) =>
      manifests.some((items) => {
        const evidence = hash([sheet, entry.name, entry.category, text, entry.base.compendium]);
        return reference.evidence === hash([...prefix(evidence), items]);
      }),
    ),
  );
}

/** The manifest facts recorded for one identity; duplicate members are not its content. */
function referenceManifest(entry: ReviewSample, hash: number) {
  const manifest = entry.evidenceManifest;
  if (!Array.isArray(manifest)) return manifest;
  const own = manifest.filter(
    (item) => item && typeof item === 'object' && (item as { hash?: number }).hash === hash,
  );
  return own.length ? own : manifest;
}

function provenSourceLink(reference: GuidanceReference) {
  const old = reference.link;
  if (!old) return;
  const proven =
    sourceFingerprint([old.gid, old.rowKey, old.section, old.cells, old.snapshot]) ===
      reference.sourceHash ||
    rawFingerprint([old.gid, old.rowKey, old.section, old.cells, old.snapshot]) ===
      reference.sourceHash;
  if (proven) return old;
}

// A formatter-only change must not invalidate an approval of unchanged source
// bodies. Replay the previously saved labels against current complete rows, and
// require BOTH the old source hash and exact styled snapshot to agree.
export function currentReferenceLink(reference: GuidanceReference, source: CompendiumData) {
  const old = provenSourceLink(reference);
  if (!old) return;
  const resolved = resolveCompendiumLink(old, source);
  const confirmed =
    resolved && 'row' in resolved ? confirmCompendiumSelection(resolved, source) : undefined;
  const link = confirmed && { ...confirmed, snapshotAt: old.snapshotAt };
  if (link) {
    const held = matchingReferenceLink(old, link, source);
    if (held) return held;
  }
  // The recorded source still exists and its text changed for real. That is a content
  // change, never a relocation: the approval stays unresolved (root brief
  // MATCHER-EVIDENCE, 2026-11-19: real wording changes stay unconfident).
  if (resolved && 'row' in resolved && !sameFormattingCell(resolved.row.cell, old.snapshot)) return;
  return relocatedReferenceLink(old, source);
}

function structuralLinkEqual(
  old: NonNullable<GuidanceReference['link']>,
  link: NonNullable<GuidanceReference['link']>,
) {
  return (
    old.gid === link.gid &&
    old.rowKey === link.rowKey &&
    old.section === link.section &&
    JSON.stringify(old.cells) === JSON.stringify(link.cells) &&
    old.setBonusPieces === link.setBonusPieces
  );
}

function matchingReferenceLink(
  old: NonNullable<GuidanceReference['link']>,
  link: NonNullable<GuidanceReference['link']>,
  source: CompendiumData,
) {
  const fingerprint = (candidate: typeof link, legacy = false) =>
    (legacy ? rawFingerprint : sourceFingerprint)([
      candidate.gid,
      candidate.rowKey,
      candidate.section,
      candidate.cells,
      candidate.snapshot,
    ]);
  if (old.setBonusPieces !== link.setBonusPieces) return;
  if (fingerprint(link) === fingerprint(old)) return link;
  // Presentation-only text churn keeps the same selected source.
  if (structuralLinkEqual(old, link) && sameFormattingCell(link.snapshot, old.snapshot)) return link;
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
  return sameCell(replay, old.snapshot) || sameFormattingCell(replay, old.snapshot)
    ? link
    : undefined;
}

/**
 * A relocated row keeps its approval only when the identical cell text exists exactly once
 * in the current Compendium (root brief MATCHER-EVIDENCE, 2026-11-19). Zero or several
 * candidates stay unresolved for review.
 */
function relocatedReferenceLink(
  old: NonNullable<GuidanceReference['link']>,
  source: CompendiumData,
) {
  if (old.parts?.length) return;
  const recorded = normaliseEvidenceFormatting(old.snapshot.plain);
  const candidates = relocationRows(source).get(recorded) ?? [];
  if (candidates.length !== 1) return;
  const [{ tab, row }] = candidates;
  if (!sameFormattingCell(row.cell, old.snapshot)) return;
  const link = confirmCompendiumSelection(
    { tab, row, cells: old.cells, setBonusPieces: old.setBonusPieces },
    source,
  );
  return link && { ...link, snapshotAt: old.snapshotAt };
}

// Formatting-folded cell text to its rows, built once per source and only on demand.
const relocationIndexes = new WeakMap<
  CompendiumData,
  Map<string, { tab: CompendiumSheet; row: CompendiumRow }[]>
>();
function relocationRows(source: CompendiumData) {
  const cached = relocationIndexes.get(source);
  if (cached) return cached;
  const rows = new Map<string, { tab: CompendiumSheet; row: CompendiumRow }[]>();
  for (const tab of source.tabs)
    for (const row of tab.rows) {
      const plain = normaliseEvidenceFormatting(row.cell.plain);
      const list = rows.get(plain);
      if (list) list.push({ tab, row });
      else rows.set(plain, [{ tab, row }]);
    }
  relocationIndexes.set(source, rows);
  return rows;
}


