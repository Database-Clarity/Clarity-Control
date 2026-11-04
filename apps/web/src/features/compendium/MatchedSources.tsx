import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { itemFor } from '../navigation/catalog';
import { useCompendiumStore } from './store';
import { useDisplayMatches } from './useDisplayMatches';
import styles from './Compendium.module.scss';

export function MatchedSources() {
  const editor = useDataStore((s) => s.data);
  const drafts = useDraftStore((s) => s.drafts);
  const userId = useAuthStore((s) => s.user?.id);
  const { data: source, load, loading, error } = useCompendiumStore();
  const result = useDisplayMatches(editor, source, drafts, userId);
  const [params, setParams] = useSearchParams();
  const query = params.get('matchedQuery') ?? '';
  const category = params.get('matchedCategory') ?? '';
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = useMemo(
    () =>
      editor && result.matches
        ? [...result.matches]
            .map(([hash, match]) => ({
              hash,
              match,
              item: itemFor(hash, editor),
            }))
            .sort((a, b) => (a.item?.name ?? '').localeCompare(b.item?.name ?? ''))
        : [],
    [editor, result.matches],
  );
  const search = query.trim().toLowerCase();
  const filtered = rows.filter(
    ({ hash, item, match }) =>
      (!category || item?.categoryId === category) &&
      (!search || `${item?.name ?? ''} ${hash} ${match.row.name}`.toLowerCase().includes(search)),
  );
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setLimit(100);
    setParams(next, { replace: true });
  };
  return (
    <section aria-label="Matched Compendium sources">
      <p>Matched sources ({rows.length}). Saved and draft links take precedence in the editor.</p>
      {(loading || result.loading) && <p role="status">Matching Compendium…</p>}
      {(error || result.error) && <p role="alert">{error || result.error}</p>}
      <label>
        Search tooltips{' '}
        <input value={query} onChange={(e) => filter('matchedQuery', e.target.value)} />
      </label>{' '}
      <label>
        Category{' '}
        <select value={category} onChange={(e) => filter('matchedCategory', e.target.value)}>
          <option value="">All categories</option>
          {editor?.categories.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <ul className={styles.rows}>
        {filtered.slice(0, limit).map(({ hash, item, match }) => (
          <li key={hash}>
            <Link to={`/t/${hash}`}>{item?.name ?? hash}</Link>{' '}
            <span className={styles.matched}>Matched</span>{' '}
            <small>
              {match.tab.name} / {match.row.name}
            </small>
          </li>
        ))}
      </ul>
      {filtered.length > limit && (
        <button type="button" onClick={() => setLimit(limit + 100)}>
          Show 100 more ({filtered.length - limit} remaining)
        </button>
      )}
      {!result.loading && !result.error && !filtered.length && (
        <p>No matched sources match these filters.</p>
      )}
    </section>
  );
}
