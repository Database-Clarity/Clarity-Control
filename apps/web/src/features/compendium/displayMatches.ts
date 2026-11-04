import { resolveCompendiumLink, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import approved from './approved-guidance.v1.json';
import { guidanceSchema, type GuidanceDocument } from './guidanceSchema';
import { guidedDecisions } from './guidedDecisions';
import { rebaselineGuidance } from './rebaselineGuidance';
import { reviewCategories } from './reviewCategories';
import { classifyScope } from './reviewScope';
import { reviewEvidence, applyReviewProgress } from './reviewQueue';
import { sourceFingerprint, type ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';

export function displayMatches(
  editor: EditorData,
  source: CompendiumData,
  drafts: Drafts,
  progress: ReviewProgress,
  local: GuidanceDocument | undefined,
  scope: string,
  proposals: Map<number, ReviewProposal>,
  approvedInput: unknown = approved,
) {
  const fingerprint = sourceFingerprint(source.tabs);
  const baseline = `${editor.bundle.sourceCommit}|${fingerprint}`;
  const evidence = reviewEvidence(editor, source, drafts, fingerprint);
  const entries = applyReviewProgress(evidence, progress);
  const categories = reviewCategories(entries, editor, proposals, false, false, source);
  // The shipped approval is immutable. Renew only evidence that the existing validator accepts.
  const shipped = guidanceSchema.parse(approvedInput);
  const document = rebaselineGuidance(shipped, categories, source, baseline, scope).document;
  const decisionsByHash = new Map(
    guidedDecisions(document, categories, proposals, source, baseline, scope)
      .flatMap((group) => group.entries)
      .map((decision) => [decision.hash, decision]),
  );
  if (local) {
    if (local.scope !== scope) throw new Error('Stored guidance belongs to another dataset.');
    const overrides = Object.fromEntries(
      Object.entries(local.categories)
        .filter(([, record]) => record.comment || Object.keys(record.references ?? {}).length)
        .map(([id, record]) => [
          id,
          {
            ...record,
            references: { ...document.categories[id]?.references, ...record.references },
          },
        ]),
    );
    // Only categories with actual local guidance override shipped approvals. Preserve the
    // local document's baseline, membership and unresolved evidence gates in those categories.
    const localDecisions = guidedDecisions(
      { ...local, categories: overrides },
      categories,
      proposals,
      source,
      baseline,
      scope,
    ).flatMap((group) => group.entries);
    for (const decision of localDecisions) decisionsByHash.set(decision.hash, decision);
  }
  const decisions = [...decisionsByHash.values()];
  const matches = decisions.flatMap((decision) => {
    if (
      decision.action !== 'link' ||
      !decision.link ||
      !['high', 'out-of-scope'].includes(decision.confidence)
    )
      return [];
    const resolved = resolveCompendiumLink(decision.link, source);
    return resolved.status === 'ok' && 'row' in resolved
      ? [[decision.hash, resolved] as const]
      : [];
  });
  return {
    matches: new Map(matches),
    decisions,
    fingerprint,
    evidence,
    categories,
    scopeHashes: categories.flatMap((category) =>
      category.entries
        .filter((entry) => !classifyScope(entry, category.id))
        .map((entry) => entry.hash),
    ),
  };
}
