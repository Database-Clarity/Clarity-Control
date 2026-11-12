import { SkeletonBoundary } from '../../ui/Skeleton';
import { isSetSelector } from './itemClassification';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { resolveAlias } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { canonicalHash, itemFor } from '../navigation/catalog';
import { compendiumChanges } from './tracking';
import { SourceRef } from './SourceRef';
import { linkLocation, matchLocation } from './sourceLocation';
import { useCompendiumStore } from './store';
import { CompendiumFreshness } from './CompendiumFreshness';
import styles from './Compendium.module.scss';
import { nonEmptyCategories } from '../../services/categoryLabels';

export function CompendiumPage() {
  const editor = useDataStore((state) => state.data);
  const { data, error, loading, load } = useCompendiumStore();
  const [params, setParams] = useSearchParams();
  const query = params.get('linkedQuery') ?? '';
  const category = params.get('linkedCategory') ?? '';
  const unlinked = params.get('linkedList') === 'unlinked';
  const [limit, setLimit] = useState(100);
  const setFilter = (key: string, value: string) => {
    setLimit(100);
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
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
      .filter((item) => !isSetSelector(item))
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
    <section>
      <p>
        Linked text and styling are compared with the last English save or review. Translation-only
        saves keep snapshots unchanged.
      </p>
      <CompendiumFreshness />
      <p>Newest snapshots first.</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" disabled={loading} onClick={() => void load(true)}>
          Reload published data
        </button>
      </div>
      <div className={styles.actions}>
        <button type="button" aria-pressed={!unlinked} onClick={() => setFilter('linkedList', '')}>
          Linked sources changed ({data ? changes.length : '...'})
        </button>
        <button
          type="button"
          aria-pressed={unlinked}
          onClick={() => setFilter('linkedList', 'unlinked')}
        >
          Tooltips without links ({missing.length})
        </button>
      </div>
      <label>
        Search tooltips
        <input value={query} onChange={(event) => setFilter('linkedQuery', event.target.value)} />
      </label>{' '}
      <label>
        Category{' '}
        <select
          value={category}
          onChange={(event) => setFilter('linkedCategory', event.target.value)}
        >
          <option value="">All categories</option>
          {nonEmptyCategories(editor).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <SkeletonBoundary
        pending={loading}
        error={!!error}
        label="Loading Compendium..."
        shape="rows"
        count={data ? Math.min(8, unlinked ? listedMissing.length : listedChanges.length) : 8}
      >
        <ul className={styles.rows}>
          {unlinked
            ? listedMissing.slice(0, limit).map((item) => (
                <li key={item.hash}>
                  <Link to={`/t/${canonicalHash(item.hash, editor)}`}>{item.name}</Link>{' '}
                  <small>{item.hash}</small>
                </li>
              ))
            : listedChanges.slice(0, limit).map(({ tooltip, resolution }) => (
                <li key={tooltip.hash}>
                  <Link to={`/t/${canonicalHash(tooltip.hash, editor)}`}>
                    {itemFor(tooltip.hash, editor)?.name ?? tooltip.hash}
                  </Link>{' '}
                  <span className={styles.badge}>
                    {resolution.status === 'candidates' ||
                    resolution.status === 'missing' ||
                    resolution.status === 'relink-suggested'
                      ? 'Needs relink'
                      : resolution.status === 'moved'
                        ? 'Moved'
                        : 'Changed'}
                  </span>{' '}
                  {tooltip.compendium && (
                    <small>
                      <SourceRef
                        location={
                          'row' in resolution
                            ? matchLocation(resolution, data)
                            : linkLocation(tooltip.compendium, data, { stale: true })
                        }
                        show="tab"
                      />
                    </small>
                  )}
                </li>
              ))}
        </ul>
        {(unlinked ? listedMissing.length : listedChanges.length) > limit && (
          <button type="button" onClick={() => setLimit(limit + 100)}>
            Show 100 more
          </button>
        )}
        {unlinked && !listedMissing.length && <p>No unlinked tooltips match these filters.</p>}
        {!unlinked && data && !listedChanges.length && (
          <p>No linked Compendium changes match these filters.</p>
        )}
      </SkeletonBoundary>
    </section>
  );
}
