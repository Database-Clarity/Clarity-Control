import { useMemo, useState } from 'react';
import type { EditorData } from '../../stores/data';
import { groupManifestItems } from './manifestItems';
import type { ReviewProposal } from './rapidReview';
import { reasonLabels, type ReviewCategory, type ReviewEntry } from './reviewCategories';
import type { useGuidance } from './useGuidance';
import styles from './CategoryReview.module.scss';

export function CategoryReview({
  categories,
  editor,
  proposals,
  guidance,
  onReview,
}: {
  categories: ReviewCategory[];
  editor: EditorData;
  proposals: Map<number, ReviewProposal>;
  guidance: ReturnType<typeof useGuidance>;
  onReview: (category?: ReviewCategory, hash?: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [browsing, setBrowsing] = useState<Record<string, number>>({});
  const manifest = useMemo(() => groupManifestItems(editor.items, editor.aliases), [editor]);
  const filtered = categories.filter((category) =>
    `${category.name} ${category.group}`.toLowerCase().includes(query.toLowerCase()),
  );
  function sample(entry: ReviewEntry) {
    const items = manifest.get(entry.hash) ?? [];
    const description = items.find((item) => item.inGameDescription.trim())?.inGameDescription;
    const proposal = proposals.get(entry.hash);
    const match = proposal?.match ?? proposal?.candidates[0];
    return (
      <li key={entry.hash}>
        <strong>{entry.name}</strong> <small>{entry.hash}</small>
        <p>{description ?? (entry.next.text.en?.text || 'No description available.')}</p>
        {!description && (
          <small>No manifest description; showing authored text when available.</small>
        )}
        <p className={styles.source}>
          {match
            ? `${proposal?.link ? 'Validated proposal' : 'Manual candidate'}: ${match.tab.name} / ${match.row.section || 'Unspecified section'} / ${match.row.name} (row ${match.row.rowIndex})`
            : 'No resolver source proposed. Manual sheet/research locations remain available in entry review.'}
        </p>
        {match && (
          <details>
            <summary>Proposed source description</summary>
            <p>{match.row.cell.plain}</p>
          </details>
        )}
      </li>
    );
  }
  function exportGuidance() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(guidance.document, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'review-guidance.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className={styles.categories} aria-label="Category guidance">
      <div className={styles.intro}>
        <div>
          <h2>Step 1: guide categories</h2>
          <p>
            {categories.length} categories ·{' '}
            {categories.reduce((sum, category) => sum + category.entries.length, 0)} entries.
            Comment on groups, not individual items.
          </p>
          <p>
            Next: agents propose decisions from your guidance, then you spot-check a few and approve
            each category.
          </p>
        </div>
        <button onClick={() => onReview()}>Review all one by one</button>
      </div>
      <div className={styles.persistence}>
        <p role="status">
          {!guidance.ready
            ? 'Loading owner guidance...'
            : guidance.saving
              ? 'Saving guidance to disk...'
              : guidance.diskSaved
                ? 'Guidance saved to apps/web/review-guidance.json. Agents can read it.'
                : 'Guidance has not been saved to disk yet.'}
        </p>
        {guidance.error && <p role="alert">{guidance.error}</p>}
        {guidance.localError && <p role="alert">{guidance.localError}</p>}
        <div>
          <button onClick={exportGuidance} disabled={!guidance.ready}>
            Export backup
          </button>
          {guidance.error && !guidance.conflict && (
            <button onClick={() => void guidance.persistence.flush()}>Retry disk save</button>
          )}
          <button
            disabled={!guidance.ready || guidance.saving}
            onClick={() => {
              if (
                guidance.diskSaved ||
                window.confirm(
                  'Discard unsaved browser guidance and reload disk? Export a backup first if you want to keep it.',
                )
              )
                void guidance.persistence.reloadDisk();
            }}
          >
            Reload disk guidance
          </button>
        </div>
      </div>
      <label className={styles.search}>
        Find category
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Weapons, armor, subclass..."
        />
      </label>
      {!categories.length && <p>No entries need category guidance.</p>}
      {categories.length > 0 && !filtered.length && <p>No categories match your search.</p>}
      <div className={styles.grid}>
        {filtered.map((category) => (
          <section className={styles.category} key={category.id} aria-label={category.name}>
            <header>
              <div>
                <small>{category.group}</small>
                <h3>{category.name}</h3>
              </div>
              <strong>{category.entries.length} entries</strong>
            </header>
            <p className={styles.breakdown}>
              {(['open', 'drafted', 'saved', 'skipped', 'no-equivalent'] as const)
                .map((status) => {
                  const count = category.entries.filter((entry) => entry.status === status).length;
                  return count ? `${count} ${status === 'open' ? 'unresolved' : status}` : '';
                })
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className={styles.reasons}>
              {Object.entries(category.reasons)
                .filter(([, entries]) => entries.length > 0)
                .map(([reason, entries]) => (
                  <details key={reason}>
                    <summary>
                      {reasonLabels[reason as keyof typeof reasonLabels]} ({entries.length})
                    </summary>
                    <ul className={styles.samples}>{entries.slice(0, 5).map(sample)}</ul>
                    {entries.length > 5 && <p>{entries.length - 5} more in this subgroup.</p>}
                  </details>
                ))}
            </div>
            <label>
              Owner guidance for {category.name}
              <textarea
                rows={4}
                maxLength={100_000}
                disabled={!guidance.ready || guidance.conflict}
                value={guidance.document.categories[category.id]?.comment ?? ''}
                placeholder="What should agents link, ignore, investigate, or ask you about?"
                onChange={(event) => guidance.persistence.comment(category.id, event.target.value)}
                onBlur={() => void guidance.persistence.flush()}
              />
            </label>
            <details>
              <summary>Representative samples ({category.samples.length})</summary>
              <ul className={styles.samples}>{category.samples.map(sample)}</ul>
            </details>
            <details>
              <summary>Browse all {category.entries.length} entries</summary>
              <ul className={styles.samples}>
                {category.entries.slice(0, browsing[category.id] ?? 20).map(sample)}
              </ul>
              {(browsing[category.id] ?? 20) < category.entries.length && (
                <button
                  onClick={() =>
                    setBrowsing((state) => ({
                      ...state,
                      [category.id]: (state[category.id] ?? 20) + 20,
                    }))
                  }
                >
                  Show 20 more
                </button>
              )}
            </details>
            <details>
              <summary>Category definition</summary>
              <p>{category.rule}</p>
            </details>
            <button onClick={() => onReview(category)}>Review these one by one</button>
          </section>
        ))}
      </div>
    </section>
  );
}
