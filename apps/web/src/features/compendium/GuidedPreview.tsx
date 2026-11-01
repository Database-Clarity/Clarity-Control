import { useMemo, useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { GuidanceDocument } from './guidanceSchema';
import type { ReviewCategory } from './reviewCategories';
import type { ReviewProposal } from './rapidReview';
import { guidedDecisions, type GuidedDecision } from './guidedDecisions';
import { RichCell } from './RichCell';

export function GuidedPreview({
  document,
  category,
  proposals,
  source,
  baseline,
  scope,
}: {
  document: GuidanceDocument;
  category: ReviewCategory;
  proposals: Map<number, ReviewProposal>;
  source: CompendiumData;
  baseline: string;
  scope: string;
}) {
  const [limit, setLimit] = useState(20);
  const group = useMemo(
    () =>
      guidedDecisions(document, [category], proposals, source, baseline, scope).find(
        (group) => group.id === category.id,
      ),
    [document, category, proposals, source, baseline, scope],
  );
  if (!group) return null;
  return (
    <details>
      <summary>
        Guided proposal preview ({group.high} high confidence, {group.unresolved} for owner)
      </summary>
      <p>
        Preview only. No drafts or category approval are created. Category acceptance awaits a
        product decision.
      </p>
      <p>
        Uses guidance from the last load, before category synchronization. Reload disk guidance to
        include newly saved examples and notes.
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
      <h4>Full recorded scope</h4>
      {group.entries.slice(0, limit).map((entry) => (
        <Decision key={entry.hash} entry={entry} />
      ))}
      {limit < group.entries.length && (
        <button onClick={() => setLimit(limit + 20)}>Show 20 more proposals</button>
      )}
    </details>
  );
}

function Decision({ entry }: { entry: GuidedDecision }) {
  return (
    <details>
      <summary>
        {entry.name} · {entry.hash} · {entry.confidence} · {entry.action}
      </summary>
      <p>{entry.reason}</p>
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
    </details>
  );
}
