import { importContext } from './importContext';
import { researchSuggestions } from './researchSuggestions';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompendiumData } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useCompendiumStore } from './store';
import { LinkPicker } from './LinkPicker';
import { applyReviewProgress, mayDraftLink, reviewEvidence } from './reviewQueue';
import { reviewStorageKey, sourceFingerprint, type ReviewProgress } from './reviewProgress';
import { useReviewProgress } from './useReviewProgress';
import styles from './Compendium.module.scss';

const labels = {
  open: 'Unresolved',
  drafted: 'Drafted',
  saved: 'Saved',
  skipped: 'Skipped for now',
  'no-equivalent': 'No equivalent found (local)',
};

export function MatchReviewPage() {
  const editor = useDataStore((state) => state.data);
  const { data, load, loading, error } = useCompendiumStore();
  const { user, loading: authLoading } = useAuthStore();
  useEffect(() => {
    void load();
  }, [load]);
  const storageKey = reviewStorageKey(
    `${bundleUrl}|${compendiumDataUrl}|${apiUrl ?? 'read-only'}`,
    user?.id,
  );
  return (
    <article className={styles.review}>
      <h1>Review Compendium matches</h1>
      <Link to="/compendium">Back to Needs attention</Link>
      <p>
        Confirm uncertain links using the sheet below. Links become normal local drafts: use the
        existing save summary to save them. Text and associations in other drafts are preserved.
      </p>
      <p>
        Skip and no-equivalent decisions are tentative progress on this browser only; they do not
        change published metadata or train a model. New source evidence reopens them.
      </p>
      {error && <p role="alert">{error}</p>}
      {(loading || authLoading) && <p role="status">Loading review data...</p>}
      {editor && data && !authLoading && (
        <ReviewQueue key={storageKey} storageKey={storageKey} editor={editor} source={data} />
      )}
    </article>
  );
}

function ReviewQueue({
  editor,
  source,
  storageKey,
}: {
  editor: EditorData;
  source: CompendiumData;
  storageKey: string;
}) {
  const { progress, update, error } = useReviewProgress(storageKey);
  const [message, setMessage] = useState('');
  const { drafts, hydrated } = useDraftStore();
  const user = useAuthStore((state) => state.user);
  const locked = useSaveState((state) => state.locked);
  const fingerprint = useMemo(() => sourceFingerprint(source.tabs), [source]);
  const evidence = useMemo(
    () => reviewEvidence(editor, source, drafts, fingerprint),
    [editor, source, drafts, fingerprint],
  );
  const entries = useMemo(() => applyReviewProgress(evidence, progress), [evidence, progress]);
  const filtered = entries.filter(
    (entry) =>
      (!progress.category || entry.category === progress.category) &&
      (!progress.query ||
        `${entry.name} ${entry.hash}`.toLowerCase().includes(progress.query.toLowerCase())) &&
      (progress.filter === 'all' || entry.status === progress.filter),
  );
  const selected = filtered.find((entry) => entry.hash === progress.selected) ?? filtered[0];
  const index = selected ? filtered.indexOf(selected) : -1;
  const selectedHash = selected?.hash;
  const selectedCategory = selected?.category;
  const selectedName = selected?.name;
  const suggestions = useMemo(
    () =>
      selectedHash !== undefined
        ? researchSuggestions(selectedHash, source, selectedCategory!, selectedName!)
        : [],
    [selectedHash, selectedCategory, selectedName, source],
  );
  const canEdit = mayDraftLink(user?.role, !!apiUrl, hydrated, locked);
  const choose = (hash: number) => update((state) => ({ ...state, selected: hash }));
  function decide(kind: 'open' | 'skipped' | 'no-equivalent', advance = false) {
    if (!selected) return;
    update((state) => ({
      ...state,
      selected: advance ? (filtered[index + 1] ?? filtered[index - 1])?.hash : selected.hash,
      decisions: { ...state.decisions, [selected.hash]: { kind, fingerprint: selected.evidence } },
    }));
  }
  function filter(patch: Partial<ReviewProgress>) {
    update((state) => ({ ...state, ...patch }));
  }
  return (
    <>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error} Progress changes remain usable in this tab.</p>}
      <p>
        {user
          ? `Progress for ${user.login}.`
          : 'Anonymous browser progress; not attributed to a signed-in user.'}
      </p>
      <p role="status">
        {Object.entries(labels)
          .map(
            ([status, label]) =>
              `${label}: ${entries.filter((entry) => entry.status === status).length}`,
          )
          .join(' · ')}
      </p>
      <div className={styles.actions}>
        <label>
          Search tooltips{' '}
          <input
            value={progress.query}
            onChange={(event) => filter({ query: event.target.value })}
          />
        </label>
        <label>
          Category{' '}
          <select
            value={progress.category}
            onChange={(event) => filter({ category: event.target.value })}
          >
            <option value="">All categories</option>
            {editor.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Progress{' '}
          <select
            value={progress.filter}
            onChange={(event) => filter({ filter: event.target.value as ReviewProgress['filter'] })}
          >
            <option value="all">All queue entries</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Selected tooltip{' '}
        <select
          value={selected?.hash ?? ''}
          onChange={(event) => choose(Number(event.target.value))}
        >
          {!filtered.length && <option value="">No matching entries</option>}
          {filtered.map((entry) => (
            <option key={entry.hash} value={entry.hash}>
              {entry.name} ({entry.hash}) — {labels[entry.status]}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => choose(filtered[index - 1].hash)}
        >
          Back
        </button>
        <span>
          {index + 1} / {filtered.length}
        </span>
        <button
          type="button"
          disabled={index < 0 || index >= filtered.length - 1}
          onClick={() => choose(filtered[index + 1].hash)}
        >
          Next
        </button>
        <button type="button" disabled={!selected} onClick={() => decide('skipped', true)}>
          Skip for now (local)
        </button>
        <button type="button" disabled={!selected} onClick={() => decide('no-equivalent', true)}>
          No equivalent found (local)
        </button>
        <button type="button" disabled={!selected} onClick={() => decide('open')}>
          Reopen local decision
        </button>
      </div>
      {selected && (
        <section className={styles.panel} aria-label="Selected tooltip review">
          <h2>{selected.name}</h2>
          <p>
            {selected.hash} · {selected.category} · {selected.reason} · {labels[selected.status]}
          </p>
          {selected.stale && <p>Evidence changed since your local decision. Please check again.</p>}
          <h3>Current English tooltip text</h3>
          <pre className={styles.english}>
            {selected.next.text.en?.text || 'No English text yet.'}
          </pre>
          {importContext(
            selected.next.text.en?.text ?? '',
            editor.bundle.tooltips,
            editor.aliases,
          ).map((context, index) => (
            <details key={index}>
              <summary>Authored import context</summary>
              <pre className={styles.english}>{context}</pre>
            </details>
          ))}
          <h3>In-game description</h3>
          <pre className={styles.english}>
            {editor.items[selected.hash]?.inGameDescription || 'No in-game description available.'}
          </pre>
          <p>
            Imports in the English text above are retained as authored context; they do not imply
            whole-description equivalence.
          </p>
          <Link to={`/t/${selected.hash}`}>Open tooltip editor / inspect draft</Link>
          {selected.status === 'drafted' && (
            <p role="status">
              Drafted, not saved. Save using the normal save summary. Discarding the draft reopens
              this entry.
            </p>
          )}
          {!canEdit && (
            <p>
              Browsing only. Linking requires a signed-in editor, trial or maintainer, recovered
              drafts, and no open save review.
            </p>
          )}
          <LinkPicker
            key={selected.hash}
            base={selected.base}
            name={selected.name}
            category={selected.category}
            suggestions={suggestions}
            readOnly={!canEdit}
            onLinked={() => {
              setMessage(`${selected.name}: link drafted, not saved. Use the normal save summary.`);
              decide('open', true);
            }}
          />
        </section>
      )}
      {!selected && (
        <p>
          No queue entries match these filters. Try All queue entries to revisit local decisions or
          drafts.
        </p>
      )}
    </>
  );
}
