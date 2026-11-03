import { resolveCompendiumLink, type CompendiumData, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { GuidanceDocument } from './guidanceSchema';
import { guidedDecisions } from './guidedDecisions';
import { proposalFor } from './rapidReview';
import { reviewCategories } from './reviewCategories';
import { reviewQueue } from './reviewQueue';
import { sourceFingerprint, type ReviewProgress } from './reviewProgress';

/** Read-only planning for one opened tooltip, using the reviewer's current evidence gates. */
export function paneMatch(
  base: Tooltip,
  editor: EditorData,
  source: CompendiumData,
  drafts: Drafts,
  progress: ReviewProgress,
  document: GuidanceDocument,
  scope: string,
) {
  // Saved links (including an explicit unlink draft) and draft links take precedence.
  if (base.compendium || drafts[base.hash]?.next.compendium) return;
  const fingerprint = sourceFingerprint(source.tabs);
  const baseline = `${editor.bundle.sourceCommit}|${fingerprint}`;
  const entries = reviewQueue(editor, source, drafts, progress, fingerprint);
  const proposals = new Map([[base.hash, proposalFor(base, editor, source)]]);
  const categories = reviewCategories(entries, editor, proposals, false, false, source);
  const category = categories.find((group) =>
    group.entries.some((entry) => entry.hash === base.hash),
  );
  if (!category) return;
  // Fresh installations can use checked-in owner approvals without creating browser guidance.
  // Existing guidance retains its frozen baseline/membership, including stale evidence.
  const input: GuidanceDocument =
    document.baseline || Object.keys(document.categories).length
      ? document
      : {
          ...document,
          baseline,
          categories: Object.fromEntries(
            categories.map((group) => [
              group.id,
              {
                id: group.id,
                name: group.name,
                rule: group.rule,
                count: group.entries.length,
                hashes: group.entries.map((entry) => entry.hash),
                active: true,
                comment: '',
                references: {},
              },
            ]),
          ),
        };
  const decision = guidedDecisions(input, categories, proposals, source, baseline, scope, base.hash)
    .find((group) => group.id === category.id)
    ?.entries.find((entry) => entry.hash === base.hash);
  if (decision?.confidence !== 'high' || decision.action !== 'link' || !decision.link) return;
  const resolved = resolveCompendiumLink(decision.link, source);
  return resolved.status === 'ok' && 'row' in resolved ? resolved : undefined;
}
