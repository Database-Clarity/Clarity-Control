import { useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
import { reasonLabels, type ReviewCategory } from './reviewCategories';
import type { useGuidance } from './useGuidance';
import { referenceCurrent } from './sampleReferences';
import { SampleReview } from './SampleReview';
import { SendGuidance } from './SendGuidance';
import styles from './CategoryReview.module.scss';
import { GuidedPreview } from './GuidedPreview';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { sourceFingerprint } from './reviewProgress';

export function CategoryReview({
  categories,
  editor,
  source,
  proposals,
  guidance,
  onReview,
  canEdit = false,
  onAccept,
}: {
  categories: ReviewCategory[];
  editor: EditorData;
  source: CompendiumData;
  proposals: Map<number, ReviewProposal>;
  guidance: ReturnType<typeof useGuidance>;
  canEdit?: boolean;
  onAccept?: (
    category: ReviewCategory,
    entries: import('./guidedDecisions').GuidedDecision[],
    revision: string,
  ) => void;
  onReview: (category?: ReviewCategory, hash?: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [browsing, setBrowsing] = useState(20);
  const [importError, setImportError] = useState<string | null>(null);
  const filtered = categories.filter((category) =>
    `${category.name} ${category.group}`.toLowerCase().includes(query.toLowerCase()),
  );
  const category = filtered.find((category) => category.id === categoryId) ?? filtered[0];
  function samples(group: ReviewCategory) {
    const references = guidance.document.categories[group.id]?.references ?? {};
    return [
      ...group.samples,
      ...group.entries.filter(
        (entry) =>
          references[entry.hash] && !group.samples.some((sample) => sample.hash === entry.hash),
      ),
    ];
  }
  function resolved(group: ReviewCategory) {
    return samples(group).filter((entry) => {
      const reference = guidance.document.categories[group.id]?.references?.[entry.hash];
      return (
        reference?.decision &&
        reference.decision !== 'skipped' &&
        referenceCurrent(reference, entry, guidance.document.baseline, source)
      );
    }).length;
  }
  const entries = category ? samples(category) : [];
  const entry = entries.find((entry) => entry.hash === selected[category?.id ?? '']) ?? entries[0];
  const paused = !guidance.ready || guidance.reloading;
  function exportGuidance() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(guidance.document, null, 2)], { type: 'application/json' }),
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
          <h2>Resolve a few examples</h2>
          <p>Agents use your examples to match the rest. References only; no tooltip saves.</p>
        </div>
        <button onClick={() => onReview()}>Review all one by one</button>
      </div>
      <div className={styles.persistence}>
        <p role="status">
          {!guidance.ready
            ? 'Loading owner guidance...'
            : guidance.reloading
              ? 'Reloading disk guidance; editing is paused...'
              : guidance.saving
                ? 'Saving examples and notes to disk...'
                : guidance.diskSaved
                  ? 'Saved to apps/web/review-guidance.json. Agents can read your examples and notes.'
                  : 'Examples and notes are not saved to disk yet.'}
        </p>
        {guidance.error && <p role="alert">{guidance.error}</p>}
        {guidance.renewalNotice && <p role="status">{guidance.renewalNotice}</p>}
        {guidance.localError && <p role="alert">{guidance.localError}</p>}
        <SendGuidance document={guidance.document} ready={guidance.ready} />
        <details>
          <summary>Backup / disk recovery</summary>
          <div>
            <button onClick={exportGuidance} disabled={!guidance.ready}>
              Export backup
            </button>
            <label>
              Import guidance backup
              <input
                type="file"
                accept="application/json,.json"
                disabled={paused || guidance.saving || guidance.conflict}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  if (
                    !window.confirm(
                      'Replace browser examples and notes with this backup? Export a backup first to keep the current guidance.',
                    )
                  )
                    return;
                  try {
                    const raw = await file.text();
                    // A reload, edit or save while reading must not be overwritten.
                    if (guidance.persistence.getSnapshot().document !== guidance.document)
                      throw new Error('Guidance changed while reading the backup. Import again.');
                    guidance.persistence.importBackup(JSON.parse(raw));
                    setImportError(null);
                  } catch (error) {
                    setImportError(
                      error instanceof Error ? error.message : 'Could not import guidance.',
                    );
                  }
                }}
              />
            </label>
            {importError && <p role="alert">{importError}</p>}
            {guidance.error && !guidance.conflict && !guidance.reloading && (
              <button onClick={() => void guidance.persistence.flush()}>Retry disk save</button>
            )}
            <button
              disabled={!guidance.ready || guidance.saving || guidance.reloading}
              onClick={() => {
                if (
                  guidance.diskSaved ||
                  window.confirm(
                    'Discard unsaved browser examples and notes and reload disk? Export a backup first to keep them.',
                  )
                )
                  void guidance.persistence.reloadDisk();
              }}
            >
              Reload disk guidance
            </button>
          </div>
        </details>
      </div>
      <div className={styles.workspace}>
        <nav className={styles.categoryList} aria-label="Review categories">
          <label>
            Find category
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Weapons, armor, subclass..."
            />
          </label>
          {!categories.length && <p>No entries need category guidance.</p>}
          {categories.length > 0 && !filtered.length && <p>No categories match your search.</p>}
          <div className={styles.categoryButtons}>
            {filtered.map((group) => (
              <button
                key={group.id}
                aria-current={group.id === category?.id ? 'true' : undefined}
                onClick={() => {
                  setCategoryId(group.id);
                  setBrowsing(20);
                }}
              >
                <strong>{group.name}</strong>
                <small>
                  {resolved(group)}/{samples(group).length} samples resolved ·{' '}
                  {group.entries.length} entries
                </small>
              </button>
            ))}
          </div>
        </nav>
        {category && (
          <section className={styles.category} aria-label={category.name}>
            <header>
              <h3>{category.name}</h3>
              <span>
                {resolved(category)}/{entries.length} samples resolved
              </span>
            </header>
            <div className={styles.sampleTabs} aria-label="Representative samples">
              {entries.map((sample, index) => (
                <button
                  key={sample.hash}
                  aria-pressed={sample.hash === entry?.hash}
                  onClick={() => setSelected((state) => ({ ...state, [category.id]: sample.hash }))}
                >
                  {index + 1}. {sample.name}
                </button>
              ))}
            </div>
            {entry && (
              <SampleReview
                key={`${category.id}:${entry.hash}`}
                entry={entry}
                category={category}
                editor={editor}
                source={source}
                proposal={proposals.get(entry.hash)}
                guidance={guidance}
              />
            )}
            <label className={styles.categoryNote}>
              Owner guidance for {category.name}
              <textarea
                rows={2}
                maxLength={100_000}
                disabled={paused}
                value={guidance.document.categories[category.id]?.comment ?? ''}
                placeholder="Any rule agents should use for this category?"
                onChange={(event) => guidance.persistence.comment(category.id, event.target.value)}
                onBlur={() => void guidance.persistence.flush()}
              />
            </label>
            <details className={styles.browse}>
              <summary>Browse / category definition ({category.entries.length} entries)</summary>
              <p>{category.rule}</p>
              <p>
                {Object.entries(category.reasons)
                  .filter(([, entries]) => entries.length)
                  .map(
                    ([reason, entries]) =>
                      `${reasonLabels[reason as keyof typeof reasonLabels]}: ${entries.length}`,
                  )
                  .join(' · ')}
              </p>
              {category.entries.slice(0, browsing).map((entry) => (
                <button key={entry.hash} onClick={() => onReview(category, entry.hash)}>
                  {entry.name} · {entry.hash}
                </button>
              ))}
              {browsing < category.entries.length && (
                <button onClick={() => setBrowsing(browsing + 20)}>Show 20 more</button>
              )}
            </details>
            <button onClick={() => onReview(category)}>Review these one by one</button>
            {guidance.ready && guidance.proposalInput && (
              <GuidedPreview
                key={category.id}
                canEdit={canEdit && !paused && !guidance.conflict && !guidance.reloading}
                onAccept={(entries, revision) => onAccept?.(category, entries, revision)}
                document={guidance.proposalInput}
                planningRevision={guidance.planningRevision}
                category={category}
                proposals={proposals}
                source={source}
                baseline={`${editor.bundle.sourceCommit}|${sourceFingerprint(source.tabs)}`}
                scope={`${bundleUrl}|${compendiumDataUrl}`}
              />
            )}
          </section>
        )}
      </div>
    </section>
  );
}
