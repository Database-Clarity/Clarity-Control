import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { bungieDrift, type Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { When } from '../../ui/When';
import { canEditTooltipFields } from '../auth/permissions';
import { reviewedSnapshot } from './review';
import styles from './Status.module.scss';

export function DriftPage() {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const [query, setQuery] = useState('');
  const locked = useSaveState((state) => state.locked);
  const [error, setError] = useState<string | null>(null);
  const result = useMemo(
    () => data && bungieDrift(Object.values(data.bundle.tooltips), data.items, data.aliases),
    [data],
  );
  const canReview = Boolean(apiUrl && canEditTooltipFields(user));
  if (!data || !result) return null;
  const search = query.trim().toLocaleLowerCase();
  const entries = result.changed.filter(
    ({ tooltip }) =>
      String(tooltip.hash).includes(search) ||
      data.items[tooltip.hash]?.name.toLocaleLowerCase().includes(search),
  );

  function markReviewed(base: Tooltip, description: string) {
    setError(null);
    try {
      const next = reviewedSnapshot(base, description, new Date().toISOString());
      reviewSaveChanges([{ hash: base.hash, base, next }]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <article className={styles.page}>
      <h1>Bungie drift</h1>
      <p>{result.changed.length} changed in-game descriptions.</p>
      <p className={styles.muted}>
        Saved manifest tooltips without a snapshot: {result.missingSnapshots} (not listed). English
        edits create snapshots for future comparisons. This view uses saved tooltips, not local
        drafts.
      </p>
      <p>Removed words are struck through; added words are underlined.</p>
      {!canReview && (
        <p className={styles.muted}>
          Sign in as a maintainer, editor or trial editor to mark descriptions reviewed.
        </p>
      )}
      <div className={styles.filters}>
        <label>
          Filter by name or hash
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void useDataStore.getState().load()}>
            Reload editor data
          </button>
        </p>
      )}
      {!entries.length && <p>No changed descriptions{query ? ' match this filter' : ''}.</p>}
      {entries.map(({ tooltip, description }) => (
        <section key={tooltip.hash} className={styles.card}>
          <h2>
            <Link to={`/t/${tooltip.hash}`}>{data.items[tooltip.hash]?.name ?? tooltip.hash}</Link>{' '}
            <small>({tooltip.hash})</small>
          </h2>
          <p className={styles.muted}>
            Snapshot: <When value={tooltip.bungieSnapshot?.snapshotAt} fallback="none" />
          </p>
          <WordDiff before={tooltip.bungieSnapshot?.description ?? ''} after={description} />
          <button
            type="button"
            disabled={!canReview || locked}
            onClick={() => markReviewed(tooltip, description)}
          >
            Mark reviewed
          </button>
        </section>
      ))}
    </article>
  );
}
