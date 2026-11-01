import { useMemo, useState } from 'react';
import type { CompendiumData, CompendiumMatch } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { errorMessage } from '../../services/http';
import { groupManifestItems } from './manifestItems';
import type { ReviewProposal } from './rapidReview';
import type { GuidanceReference } from './guidanceSchema';
import type { ReviewCategory, ReviewSample } from './reviewCategories';
import type { useGuidance } from './useGuidance';
import { referenceCurrent, sampleReference } from './sampleReferences';
import { LinkPicker } from './LinkPicker';
import { RichCell } from './RichCell';
import styles from './CategoryReview.module.scss';

const decisions = {
  accepted: 'Proposed link accepted',
  picked: 'Other source selected',
  'no-equivalent': 'No equivalent',
  skipped: 'Skipped; revisit later',
};
export function SampleReview({
  entry,
  category,
  editor,
  source,
  proposal,
  guidance,
}: {
  entry: ReviewSample;
  category: ReviewCategory;
  editor: EditorData;
  source: CompendiumData;
  proposal?: ReviewProposal;
  guidance: ReturnType<typeof useGuidance>;
}) {
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const reference = guidance.document.categories[category.id]?.references?.[entry.hash];
  const current = referenceCurrent(reference, entry, guidance.document.baseline, source);
  const items = useMemo(
    () => groupManifestItems(editor.items, editor.aliases).get(entry.hash) ?? [],
    [editor, entry.hash],
  );
  const description = items.find((item) => item.inGameDescription.trim())?.inGameDescription;
  const match = proposal?.match ?? proposal?.candidates[0];
  const paused = !guidance.ready || guidance.reloading;
  function decide(decision?: GuidanceReference['decision'], match?: CompendiumMatch) {
    try {
      guidance.persistence.reference(
        category.id,
        sampleReference(
          entry,
          category.id,
          guidance.document.baseline,
          reference?.note ?? '',
          decision,
          match,
          source,
        ),
      );
      setError('');
      setPicker(false);
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <section className={styles.sample} aria-label={`Resolve sample ${entry.name}`} tabIndex={0}>
      <div className={styles.comparison}>
        <section aria-label="Sample entry">
          <h3>
            {entry.name} <small>{entry.hash}</small>
          </h3>
          <p>{description ?? (entry.base.text.en?.text || 'No description available.')}</p>
          {!description && (
            <small>No manifest description; showing authored text when available.</small>
          )}
          {items.length > 1 && <small>{items.length} manifest items share this description.</small>}
        </section>
        <section aria-label="Sample proposed source">
          <h3>{proposal?.link ? 'Proposed source' : 'Manual candidate'}</h3>
          {match ? (
            <>
              <p className={styles.source}>
                {match.tab.name} / {match.row.section || 'Unspecified section'} / {match.row.name} ·
                row {match.row.rowIndex}
              </p>
              <RichCell cell={match.row.cell} />
            </>
          ) : (
            <p>No proposed source. Pick other to search every tab, or mark no equivalent.</p>
          )}
        </section>
      </div>
      <p role="status">
        {reference?.decision
          ? `${decisions[reference.decision]}${reference.sourceName ? `: ${reference.sourceName} / ${reference.sourceTab}` : ''}${current ? '' : ' — evidence changed; resolve again.'}`
          : 'Resolve this example so agents can use it as a reference.'}
      </p>
      {reference?.link && (
        <details>
          <summary>Chosen source description</summary>
          <RichCell cell={reference.link.snapshot} />
        </details>
      )}
      <div className={styles.actions}>
        <p className={styles.actionEyebrow}>Saves as example · no tooltip change</p>
        <button
          disabled={paused || !proposal?.link || !proposal.match}
          onClick={() => decide('accepted', proposal?.match)}
        >
          Accept proposed link
        </button>
        <button disabled={paused} onClick={() => setPicker(!picker)}>
          Pick other
        </button>
        <button disabled={paused} onClick={() => decide('no-equivalent')}>
          No equivalent
        </button>
        <button disabled={paused} onClick={() => decide('skipped')}>
          Skip
        </button>
        {reference?.decision && (
          <button disabled={paused} onClick={() => decide()}>
            Clear decision
          </button>
        )}
      </div>
      {picker && (
        <div className={styles.picker}>
          <button onClick={() => setPicker(false)}>Close picker</button>
          <LinkPicker
            base={entry.base}
            name={entry.name}
            category={entry.category}
            readOnly={paused}
            onReference={(match) => decide('picked', match)}
            onLinked={() => setPicker(false)}
          />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <label>
        Note for {entry.name} (optional)
        <textarea
          rows={2}
          maxLength={10_000}
          disabled={paused}
          value={reference?.note ?? ''}
          placeholder="What makes this a good match, or why is it different?"
          onChange={(event) => {
            try {
              guidance.persistence.reference(category.id, {
                ...(reference ??
                  sampleReference(entry, category.id, guidance.document.baseline, '')),
                note: event.target.value,
                timestamp: new Date().toISOString(),
              });
              setError('');
            } catch (error) {
              setError(errorMessage(error));
            }
          }}
          onBlur={() => void guidance.persistence.flush()}
        />
      </label>
    </section>
  );
}
