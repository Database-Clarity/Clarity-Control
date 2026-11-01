import { normaliseCompendiumName, type CompendiumData, type CompendiumLink } from '@clarity/core';
import type { GuidanceDocument, GuidanceReference } from './guidanceSchema';
import type { ReviewCategory, ReviewSample } from './reviewCategories';
import type { ReviewProposal } from './rapidReview';
import { referenceCurrent } from './sampleReferences';
import { sourceFingerprint } from './reviewProgress';

export interface GuidedDecision {
  hash: number;
  name: string;
  categoryId: string;
  confidence: 'high' | 'unresolved';
  action: 'link' | 'no-equivalent' | 'owner' | 'preserve';
  reason: string;
  references: number[];
  evidence?: string;
  link?: CompendiumLink;
}
export interface GuidedCategory {
  id: string;
  name: string;
  comment: string;
  pattern: string;
  issues: string[];
  entries: GuidedDecision[];
  high: number;
  unresolved: number;
  samples: number[];
  referenceEvidence: GuidanceReference[];
}

const location = (link: CompendiumLink) => JSON.stringify([link.gid, link.section ?? '']);
const exactName = (name: string, other: string) =>
  !!normaliseCompendiumName(name) &&
  normaliseCompendiumName(name) === normaliseCompendiumName(other);

// Pure planning only. No drafts, progress, guidance writes, authentication or save calls.
export function guidedDecisions(
  document: GuidanceDocument,
  categories: ReviewCategory[],
  proposals: Map<number, ReviewProposal>,
  source: CompendiumData,
  baseline: string,
  scope: string,
): GuidedCategory[] {
  const current = new Map(categories.map((category) => [category.id, category]));
  return Object.values(document.categories)
    .filter((record) => record.active)
    .map((record) => {
      const category = current.get(record.id);
      const entries = new Map(category?.entries.map((entry) => [entry.hash, entry]));
      const issues: string[] = [];
      const compatible = document.scope === scope && document.baseline === baseline;
      if (document.scope !== scope) issues.push('Dataset scope differs; all proposals withheld.');
      if (document.baseline !== baseline)
        issues.push('Baseline differs; renew references before proposing.');
      if (!category) issues.push('Recorded category is absent from the current review queue.');
      const references = Object.values(record.references ?? {});
      const usable = new Map<number, GuidanceReference>();
      for (const reference of references) {
        const entry = entries.get(reference.hash);
        if (
          !record.hashes.includes(reference.hash) ||
          !entry ||
          !compatible ||
          !referenceCurrent(reference, entry, baseline, source)
        ) {
          issues.push(
            `Reference ${reference.hash}: stale, missing or outside recorded membership.`,
          );
        } else if (reference.decision && reference.decision !== 'skipped') {
          usable.set(reference.hash, reference);
        }
      }
      const extra = category?.entries.filter((entry) => !record.hashes.includes(entry.hash)) ?? [];
      if (extra.length) issues.push(`${extra.length} new entries excluded from recorded scope.`);
      const patterns = new Map<string, number[]>();
      for (const reference of usable.values()) {
        // A picked rename/cell selection is an example for itself, never a generic mapping rule.
        if (
          !reference.link ||
          reference.link.cells ||
          reference.note.trim() ||
          !reference.sourceName ||
          !exactName(reference.name, reference.sourceName)
        )
          continue;
        const key = location(reference.link);
        patterns.set(key, [...(patterns.get(key) ?? []), reference.hash]);
      }
      const decide = (hash: number): GuidedDecision => {
        const entry: ReviewSample | undefined = entries.get(hash);
        const result: GuidedDecision = {
          hash,
          name: entry?.name ?? references.find((ref) => ref.hash === hash)?.name ?? String(hash),
          categoryId: record.id,
          action: 'owner',
          confidence: 'unresolved',
          references: [],
          evidence: entry?.sampleEvidence,
          reason: 'No supported mapping; owner decision needed.',
        };
        if (!entry)
          return { ...result, reason: 'Recorded entry is missing or no longer in this category.' };
        if (entry.base.compendium || entry.next.compendium || entry.status !== 'open')
          return {
            ...result,
            action: 'preserve',
            reason: 'Existing link, draft or human review decision preserved.',
          };
        if (!compatible)
          return { ...result, reason: 'Scope or baseline differs; proposal withheld.' };
        const reference = usable.get(hash);
        if (reference)
          return {
            ...result,
            action: reference.link ? 'link' : 'no-equivalent',
            confidence: 'high',
            link: reference.link,
            references: [hash],
            reason: 'Current explicit owner reference; applies to this entry only.',
          };
        // Never override an unresolved/stale/skipped/note-only owner sample with an inferred rule.
        if (record.references?.[hash])
          return { ...result, reason: 'Owner sample unresolved or stale; not inferred.' };
        if (record.comment.trim())
          return {
            ...result,
            reason: 'Category comment needs agent interpretation; no automatic rule applied.',
          };
        const proposal = proposals.get(hash);
        if (!proposal?.link || !proposal.match || !exactName(entry.name, proposal.match.row.name))
          return {
            ...result,
            reason: proposal?.candidates.length
              ? 'Fuzzy or ambiguous source requires owner selection.'
              : 'No exact validated resolver proposal.',
          };
        const support = patterns.get(location(proposal.link)) ?? [];
        if (support.length < 2 || proposal.link.cells)
          return {
            ...result,
            reason: 'Fewer than two comparable owner references support this source section.',
          };
        return {
          ...result,
          confidence: 'high',
          action: 'link',
          link: proposal.link,
          references: support,
          reason:
            'Validated exact-name whole-description mapping in the source tab/section confirmed by these owner references.',
        };
      };
      const decisions = record.hashes.map(decide);
      const high = decisions.filter((entry) => entry.confidence === 'high').length;
      // Deterministic stratification by outcome, with remaining exceptions available in full below.
      const stratum = (entry: GuidedDecision) =>
        `${entry.action}:${entry.confidence}:${entry.references.includes(entry.hash) ? 'reference' : 'pattern'}`;
      const samples = [...new Set(decisions.map(stratum))]
        .flatMap((kind) => decisions.filter((entry) => stratum(entry) === kind).slice(0, 2))
        .map((entry) => entry.hash);
      return {
        id: record.id,
        name: category?.name ?? record.name,
        comment: record.comment,
        pattern:
          'Exact-name validated whole-description links; at least two current same-category examples in the same source tab/section. No-equivalent and picked renames apply only to their explicit sample.',
        issues,
        entries: decisions,
        high,
        unresolved: decisions.length - high,
        samples,
        referenceEvidence: references,
      };
    });
}

export function guidedRevision(groups: GuidedCategory[]) {
  return sourceFingerprint(groups);
}
