import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SkeletonBoundary } from '../../ui/Skeleton';
import { When } from '../../ui/When';
import { editorPath } from '../queue/editorPath';
import { SourceRef } from './SourceRef';
import { useCompendiumStore } from './store';
import { CompendiumFreshness } from './CompendiumFreshness';
import { useLinkedSources } from './linkedSources';
import styles from './CompendiumTab.module.scss';

/** Opens the editor with the Compendium pane showing (a phone has it behind a tab). */
export const compendiumPaneState = { pane: 'compendium' };

/** The Source changes list; its filters are in the left column. */
export function CompendiumPage() {
  const { error, loading, load } = useCompendiumStore();
  const { editor, list, query, category, rows, categories, shown } = useLinkedSources();
  const filters = `${list}|${query}|${category}`;
  const [more, setMore] = useState({ filters, limit: 100 });
  const limit = more.filters === filters ? more.limit : 100;
  if (!editor) return null;
  const labels = new Map(editor.categories.map(({ id, label }) => [id, label]));
  const label = category && categories.find(({ id }) => id === category)?.label;
  return (
    <section className={styles.linkedView}>
      <header className={styles.summary}>
        <h1 className={styles.heading}>
          {list === 'unlinked' ? 'Tooltips without links' : 'Source changes'}
          {label ? ` · ${label}` : ''}
        </h1>
        <span className={styles.counts}>
          {rows && `${shown.length.toLocaleString('en')} shown`}
        </span>
      </header>
      <p className={styles.muted}>
        {list === 'unlinked'
          ? 'Tooltips without a saved Compendium link.'
          : 'Linked Compendium text compared with the last English save or review, newest snapshot first.'}
      </p>
      <div className={styles.freshness}>
        <CompendiumFreshness />
        <button type="button" disabled={loading} onClick={() => void load(true)}>
          Reload published data
        </button>
      </div>
      <SkeletonBoundary
        pending={loading || (!rows && !error)}
        error={!!error}
        label="Loading Compendium..."
        shape="rows"
        count={rows ? Math.min(8, shown.length) : 8}
      >
        <ul className={styles.linkedRows}>
          {shown.slice(0, limit).map((row) => (
            <li key={row.hash}>
              <Link to={editorPath(row.hash, editor)} state={compendiumPaneState}>
                {row.name}
              </Link>
              <span className={styles.linkedCategory}>
                {labels.get(row.category) ?? `Other: ${row.category}`}
              </span>
              {row.status && (
                <>
                  <span className={styles.linkedStatus} data-status={row.status}>
                    {row.status}
                  </span>
                  <span className={styles.linkedSource}>
                    {row.location && <SourceRef location={row.location} show="tab" />}
                  </span>
                  <span className={styles.linkedDate}>
                    <When value={row.snapshotAt} nowrap />
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        {shown.length > limit && (
          <button type="button" onClick={() => setMore({ filters, limit: limit + 100 })}>
            Show 100 more
          </button>
        )}
        {rows && !shown.length && (
          <p className={styles.muted}>
            {list === 'unlinked'
              ? 'No tooltips without links match these filters.'
              : query || category
                ? 'No source changes match these filters.'
                : 'Every linked source is as it was saved.'}
          </p>
        )}
      </SkeletonBoundary>
    </section>
  );
}
