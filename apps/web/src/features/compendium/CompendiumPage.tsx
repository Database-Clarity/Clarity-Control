import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { resolveAlias } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { canonicalHash, itemFor } from '../navigation/catalog';
import { compendiumChanges } from './tracking';
import { useCompendiumStore } from './store';
import { CompendiumFreshness } from './CompendiumFreshness';
import styles from './Compendium.module.scss';
export function CompendiumPage() {
  const editor = useDataStore((state) => state.data);
  const { data, error, loading, load } = useCompendiumStore();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [unlinked, setUnlinked] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  const changes = useMemo(
    () => (editor && data ? compendiumChanges(editor.bundle.tooltips, data) : []),
    [editor, data],
  );
  const missing = useMemo(() => {
    if (!editor) return [];
    const hashes = new Set([
      ...Object.values(editor.items).map((item) => item.hash),
      ...Object.values(editor.bundle.tooltips).map((tooltip) => tooltip.hash),
    ]);
    return [...hashes]
      .filter(
        (hash) =>
          hash > 3 &&
          resolveAlias(hash, editor.aliases) === hash &&
          !editor.bundle.tooltips[hash]?.compendium,
      )
      .map((hash) => itemFor(hash, editor))
      .filter((item) => !!item)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [editor]);
  if (!editor) return null;
  const search = query.trim().toLowerCase();
  const matches = (hash: number) => {
    const item = itemFor(hash, editor);
    return (
      (!category || item?.categoryId === category) &&
      (!search || `${item?.name ?? ''} ${hash}`.toLowerCase().includes(search))
    );
  };
  const listedChanges = changes.filter(({ tooltip }) => matches(tooltip.hash));
  const listedMissing = missing.filter((item) => matches(item.hash));
  return (
    <article>
      <h1>Compendium</h1>
      <p>
        Linked text and styling are compared with the last English save or review. Translation-only
        saves keep snapshots unchanged.
      </p>
      <p>
        <Link to="/compendium/review">Review matches — resolve unlinked and broken links</Link>
      </p>
      <CompendiumFreshness />
      <p>Newest snapshots first.</p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading Compendium...</p>}
      <div className={styles.actions}>
        <button type="button" disabled={loading} onClick={() => void load(true)}>
          Reload published data
        </button>
      </div>
      <div className={styles.actions}>
        <button type="button" aria-pressed={!unlinked} onClick={() => setUnlinked(false)}>
          Needs attention ({data ? changes.length : '...'})
        </button>
        <button type="button" aria-pressed={unlinked} onClick={() => setUnlinked(true)}>
          Unlinked ({missing.length})
        </button>
      </div>
      <label>
        Search tooltips <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>{' '}
      <label>
        Category{' '}
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">All categories</option>
          {editor.categories.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <ul className={styles.rows}>
        {unlinked
          ? listedMissing.map((item) => (
              <li key={item.hash}>
                <Link to={`/t/${canonicalHash(item.hash, editor)}`}>{item.name}</Link>{' '}
                <small>{item.hash}</small>
              </li>
            ))
          : listedChanges.map(({ tooltip, resolution }) => (
              <li key={tooltip.hash}>
                <Link to={`/t/${canonicalHash(tooltip.hash, editor)}`}>
                  {itemFor(tooltip.hash, editor)?.name ?? tooltip.hash}
                </Link>{' '}
                <span className={styles.badge}>
                  {resolution.status === 'candidates' || resolution.status === 'missing'
                    ? 'Needs relink'
                    : resolution.status === 'moved'
                      ? 'Moved'
                      : 'Changed'}
                </span>{' '}
                <small>{tooltip.compendium?.rowKey}</small>
              </li>
            ))}
      </ul>
      {unlinked && !listedMissing.length && <p>No unlinked tooltips match these filters.</p>}
      {!unlinked && data && !listedChanges.length && (
        <p>No linked Compendium changes match these filters.</p>
      )}
    </article>
  );
}
