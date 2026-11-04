import { useMemo, useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { GuidanceDocument } from './guidanceSchema';
import type { ReviewCategory } from './reviewCategories';
import type { ReviewProposal } from './rapidReview';
import {
  guidedDecisions,
  guidedRevision,
  type GuidedCategory,
  type GuidedDecision,
} from './guidedDecisions';
import { RichCell } from './RichCell';
import { ReviewDetails } from './ReviewDetails';

export function GuidedPreview({
  document,
  planningRevision = 0,
  category,
  categories,
  proposals,
  source,
  baseline,
  scope,
  canEdit = false,
  onAccept,
  onRestore,
  computedGroups,
}: {
  computedGroups?: GuidedCategory[];
  onRestore?: (hash: number) => void;
  document: GuidanceDocument;
  planningRevision?: number;
  category: ReviewCategory;
  categories?: ReviewCategory[];
  proposals: Map<number, ReviewProposal>;
  source: CompendiumData;
  baseline: string;
  scope: string;
  canEdit?: boolean;
  onAccept?: (entries: GuidedDecision[], revision: string) => void;
}) {
  const [preview, setPreview] = useState<{
    group: GuidedCategory;
    tier: 'high' | 'medium';
    planningRevision: number;
  }>();
  const [limit, setLimit] = useState(20);
  const group = useMemo(
    () =>
      (
        computedGroups ??
        guidedDecisions(document, categories ?? [category], proposals, source, baseline, scope)
      ).find((group) => group.id === category.id),
    [document, category, categories, proposals, source, baseline, scope, computedGroups],
  );
  if (!group) return null;
  const current =
    !preview ||
    (planningRevision === preview.planningRevision &&
      guidedRevision([group]) === guidedRevision([preview.group]));
  const shown = preview?.group ?? group;
  const actionable = group.entries.filter((entry) => entry.confidence !== 'out-of-scope');
  const candidates = shown.entries.filter(
    (entry) => entry.confidence === preview?.tier && entry.action === 'link',
  );
  return (
    <ReviewDetails
      summary={`Guided proposal preview (${group.high} high confidence, ${group.medium} medium, ${group.unresolved} for owner)`}
    >
      {() => (
        <>
          <p>
            Acceptance creates local link-only drafts. Review &amp; save uses the normal save flow.
          </p>
          <p>{group.ownerNote}</p>
          <ReviewDetails
            summary={`Not needed (${group.entries.filter((entry) => entry.confidence === 'out-of-scope').length})`}
          >
            {group.entries
              .filter((entry) => entry.confidence === 'out-of-scope')
              .map((entry) => (
                <div key={entry.hash}>
                  {entry.name} · {entry.hash}{' '}
                  <button onClick={() => onRestore?.(entry.hash)}>Restore to scope</button>
                </div>
              ))}
          </ReviewDetails>
          <button
            disabled={!canEdit}
            onClick={() =>
              setPreview({ group: structuredClone(group), tier: 'high', planningRevision })
            }
          >
            Preview all high
          </button>{' '}
          <button
            disabled={!canEdit}
            onClick={() =>
              setPreview({ group: structuredClone(group), tier: 'medium', planningRevision })
            }
          >
            Review medium
          </button>
          {preview && (
            <section aria-label="Category acceptance preview">
              <p>
                {candidates.length} {preview.tier} links in this frozen preview. Source descriptions
                below are pre-selected.
              </p>
              {!current && <p role="alert">Evidence changed. Open a new preview.</p>}
              {candidates.map((entry) => (
                <section key={entry.hash}>
                  <Decision entry={entry} />
                  {entry.link && <RichCell cell={entry.link.snapshot} />}
                  {preview.tier === 'medium' && (
                    <button
                      disabled={!canEdit || !current}
                      onClick={() => {
                        onAccept?.([entry], guidedRevision([shown]));
                        setPreview(undefined);
                      }}
                    >
                      Confirm {entry.name} as draft
                    </button>
                  )}
                </section>
              ))}
              {preview.tier === 'high' && (
                <button
                  disabled={!canEdit || !current || !candidates.length}
                  onClick={() => {
                    onAccept?.(candidates, guidedRevision([shown]));
                    setPreview(undefined);
                  }}
                >
                  Accept all high ({candidates.length}) as drafts
                </button>
              )}
              <button onClick={() => setPreview(undefined)}>Cancel preview</button>
            </section>
          )}
          <p>
            Uses current owner examples and notes within the membership loaded for this session.
            Evidence changes invalidate an open preview; reload disk guidance to renew membership.
          </p>
          <p>
            Scope: {group.entries.length} recorded entries. Samples are a spot-check, not individual
            review of the full category.
          </p>
          <p>{group.pattern}</p>
          {group.issues.map((issue) => (
            <p key={issue} role="alert">
              {issue}
            </p>
          ))}
          <p>Spot-check hashes: {group.samples.join(', ')}</p>
          <h4>Spot-check examples</h4>
          {group.entries
            .filter((entry) => group.samples.includes(entry.hash))
            .map((entry) => (
              <Decision key={entry.hash} entry={entry} />
            ))}
          <h4>In-scope proposals</h4>
          {actionable.slice(0, limit).map((entry) => (
            <Decision key={entry.hash} entry={entry} />
          ))}
          {limit < actionable.length && (
            <button onClick={() => setLimit(limit + 20)}>Show 20 more proposals</button>
          )}
        </>
      )}
    </ReviewDetails>
  );
}

function Decision({ entry }: { entry: GuidedDecision }) {
  return (
    <ReviewDetails
      summary={`${entry.name} · ${entry.hash} · ${entry.confidence} · ${entry.action}`}
    >
      <p>
        {entry.ruleId}: {entry.reason}
      </p>
      <p>
        Category: {entry.categoryId}. Supporting references: {entry.references.join(', ') || 'none'}
        .
      </p>
      {entry.link && (
        <>
          <p>
            Source: tab {entry.link.gid}, {entry.link.rowKey}, {entry.link.section}
          </p>
          <RichCell cell={entry.link.snapshot} />
        </>
      )}
    </ReviewDetails>
  );
}
