import { languageLabel } from '../../languageLabels';
import { memo, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { globalUsageCount } from './model';
import { useDataStore } from '../../stores/data';
import { canonicalHash, classifiedCategory, itemFor } from '../navigation/catalog';
import { globalPath, globalTypes } from './model';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { useGlobals, useGlobalUsages } from './useGlobals';
import styles from './GlobalsPage.module.scss';

const tooltipCount = (count: number) => `Used in ${count} tooltip${count === 1 ? '' : 's'}`;

export function GlobalsPage() {
  const entries = useGlobals();
  const [query, setQuery] = useState('');
  return (
    <article className={styles.page}>
      <h1>Globals</h1>
      <p>
        Shared definitions from <Link to="/t/2">variables</Link> and <Link to="/t/3">titles</Link>.
        Counts include authored references in reusable exports and local titles.
      </p>
      <label>
        Find a global{' '}
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {globalTypes.map(({ kind, label }) => (
        <section key={kind}>
          <h2>{label}</h2>
          <ul className={styles.list}>
            {entries
              .filter(
                (entry) =>
                  entry.kind === kind && entry.name.toLowerCase().includes(query.toLowerCase()),
              )
              .map((entry) => (
                <li key={entry.name}>
                  <Link
                    to={globalPath(entry)}
                    title={Object.values(entry.definitions).join('\n\n')}
                  >
                    {entry.name}
                  </Link>
                  <span>{tooltipCount(globalUsageCount([entry]))}</span>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {!entries.length && <p>No global definitions found.</p>}
    </article>
  );
}

export function GlobalDetailPage() {
  const { kind, name } = useParams<'kind' | 'name'>();
  const entries = useGlobals();
  const entry = entries.find((candidate) => candidate.kind === kind && candidate.name === name);
  return entry ? (
    <Navigate to={globalPath(entry)} replace />
  ) : (
    <article className={styles.page}>
      <Link to="/globals">Back to globals</Link>
      <h1>Global not found.</h1>
    </article>
  );
}

export function GlobalUsageSummary({ hash }: { hash: number }) {
  const entries = useGlobals();
  if (hash !== 2 && hash !== 3) return null;
  const kind = hash === 2 ? 'variables' : 'titles';
  return (
    <p>
      Used in {globalUsageCount(entries.filter((entry) => entry.kind === kind))} tooltips.{' '}
      <Link to="/globals">Browse {kind} and jump to references</Link>.
    </p>
  );
}

export const GlobalUsages = memo(function GlobalUsages({
  hash,
  name,
}: {
  hash: number;
  name: string;
}) {
  const usages = useGlobalUsages(hash, name);
  const data = useDataStore((state) => state.data);
  const key = `${hash}:${name}`;
  const [paging, setPaging] = useState({ key, page: 0 });
  if (paging.key !== key) setPaging({ key, page: 0 });
  const lastPage = Math.max(0, Math.ceil(usages.length / 25) - 1);
  const page = paging.key === key ? Math.min(paging.page, lastPage) : 0;
  return useMemo(
    () => (
      <RightPane
        className={styles.usagePane}
        label="Global usages"
        header={
          <RightPaneHeader title="References">
            {usages.length > 25 && (
              <span className={styles.pager}>
                <button
                  type="button"
                  data-perf-navigation="true"
                  aria-label="Previous usages"
                  disabled={page === 0}
                  onClick={() => setPaging({ key, page: page - 1 })}
                >
                  ‹
                </button>
                <span role="status">
                  {page * 25 + 1}–{Math.min(usages.length, (page + 1) * 25)} / {usages.length}
                </span>
                <button
                  type="button"
                  data-perf-navigation="true"
                  aria-label="Next usages"
                  disabled={page === lastPage}
                  onClick={() => setPaging({ key, page: page + 1 })}
                >
                  ›
                </button>
              </span>
            )}
          </RightPaneHeader>
        }
      >
        <div className={styles.usageBody}>
          {!usages.length && <p className={styles.empty}>No authored references.</p>}
          <ul className={styles.usages}>
            {usages.slice(page * 25, (page + 1) * 25).map((usage) => {
              const item = data && itemFor(usage.hash, data);
              const category = data && classifiedCategory(item, data)?.label;
              return (
                <li key={`${usage.hash}:${usage.lang}:${usage.line}`}>
                  <Link
                    className={styles.usageLink}
                    to={`/t/${data ? canonicalHash(usage.hash, data) : usage.hash}?lang=${usage.lang}&line=${usage.line}&variant=${usage.hash}`}
                  >
                    <span className={styles.usageName}>{item?.name ?? usage.hash}</span>
                    <span className={styles.usageMeta}>
                      {category && <span>{category}</span>}
                      <span>
                        {languageLabel(usage.lang)} · line {usage.line}
                      </span>
                    </span>
                    <code>{usage.source}</code>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </RightPane>
    ),
    [usages, data, key, page, lastPage],
  );
});

export const GlobalUsageCount = memo(function GlobalUsageCount({
  hash,
  name,
}: {
  hash: number;
  name: string;
}) {
  const usages = useGlobalUsages(hash, name);
  return <p className={styles.usageCount}>{tooltipCount(globalUsageCount([{ usages }]))}</p>;
});
