import { resolveCompendiumLink, type CompendiumData, type CompendiumMatch } from '@clarity/core';
import type { GuidanceReference } from './guidanceSchema';
import type { ReviewEntry } from './reviewCategories';
import { sourceFingerprint } from './reviewProgress';
import { confirmCompendiumSelection } from './selection';

export function sampleReference(
  entry: ReviewEntry,
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
    evidence: entry.evidence,
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
  entry: ReviewEntry,
  baseline: string,
  source: CompendiumData,
) {
  if (!reference || reference.evidence !== entry.evidence || reference.baseline !== baseline)
    return false;
  if (!reference.link) return true;
  const resolved = resolveCompendiumLink(reference.link, source);
  if (!('row' in resolved)) return false;
  const link = confirmCompendiumSelection(resolved, source);
  return (
    !!link &&
    sourceFingerprint([link.gid, link.rowKey, link.section, link.cells, link.snapshot]) ===
      reference.sourceHash
  );
}
