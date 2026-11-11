import { languageLabel } from '../../languageLabels';
import { memo, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { globalUsageCount } from './model';
import { useDataStore } from '../../stores/data';
import { canonicalHash, itemFor } from '../navigation/catalog';
import { globalPath, globalTypes } from './model';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { useGlobals, useGlobalUsages } from './useGlobals';
import styles from './GlobalsPage.module.scss';

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
                  <span>Used in {globalUsageCount([entry])} tooltips</span>
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
  return useMemo(
    () => (
      <RightPane
        className={styles.usagePane}
        label="Global usages"
        header={<RightPaneHeader title="Usages" />}
      >
        <div className={styles.usageBody}>
          <p>Used in {globalUsageCount([{ usages }])} tooltips.</p>
          {!usages.length && <p>No authored references.</p>}
          <ul className={styles.usages}>
            {usages.map((usage) => (
              <li key={`${usage.hash}:${usage.lang}:${usage.line}`}>
                <Link
                  to={`/t/${data ? canonicalHash(usage.hash, data) : usage.hash}?lang=${usage.lang}&line=${usage.line}&variant=${usage.hash}`}
                >
                  {data ? (itemFor(usage.hash, data)?.name ?? usage.hash) : usage.hash} /{' '}
                  {languageLabel(usage.lang)} / line {usage.line}
                </Link>
                <small>{data ? itemFor(usage.hash, data)?.categoryId : ''}</small>
                <pre>{usage.source}</pre>
              </li>
            ))}
          </ul>
        </div>
      </RightPane>
    ),
    [usages, data],
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
  return <p className={styles.usageCount}>Used in {globalUsageCount([{ usages }])} tooltips</p>;
});
