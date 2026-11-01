import { languageLabel } from '../../languageLabels';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { globalTooltipCount } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { canonicalHash, itemFor } from '../navigation/catalog';
import { useGlobals } from './useGlobals';
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
      {(['variables', 'titles'] as const).map((kind) => (
        <section key={kind}>
          <h2>{kind === 'variables' ? 'Variables' : 'Titles'}</h2>
          <ul className={styles.list}>
            {entries
              .filter(
                (entry) =>
                  entry.kind === kind && entry.name.toLowerCase().includes(query.toLowerCase()),
              )
              .map((entry) => (
                <li key={entry.name}>
                  <Link to={`/globals/${kind}/${encodeURIComponent(entry.name)}`}>
                    {kind === 'variables' ? '#' : ''}
                    {entry.name}
                  </Link>
                  <span>Used in {globalTooltipCount([entry])} tooltips</span>
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
  const data = useDataStore((state) => state.data);
  const entry = entries.find((candidate) => candidate.kind === kind && candidate.name === name);
  return (
    <article className={styles.page}>
      <Link to="/globals">Back to globals</Link>
      <h1>
        {kind}: {name}
      </h1>
      {!entry ? (
        <p>Global not found.</p>
      ) : (
        <>
          <p>
            Used in {globalTooltipCount([entry])} tooltips. Choose a reference to jump to its
            highlighted source line.
          </p>
          <details>
            <summary>Definitions</summary>
            {Object.entries(entry.definitions).map(([lang, value]) => (
              <pre key={lang}>
                {languageLabel(lang)}: {value}
              </pre>
            ))}
          </details>
          {!entry.usages.length && <p>No authored references.</p>}
          <ul className={styles.usages}>
            {entry.usages.map((usage) => (
              <li key={`${usage.hash}:${usage.lang}:${usage.line}`}>
                <Link
                  to={`/t/${data ? canonicalHash(usage.hash, data) : usage.hash}?lang=${usage.lang}&line=${usage.line}&variant=${usage.hash}`}
                >
                  {data ? (itemFor(usage.hash, data)?.name ?? usage.hash) : usage.hash} /{' '}
                  {languageLabel(usage.lang)} / line {usage.line}
                </Link>
                <pre>
                  <mark>{usage.source}</mark>
                </pre>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

export function GlobalUsageSummary({ hash }: { hash: number }) {
  const entries = useGlobals();
  if (hash !== 2 && hash !== 3) return null;
  const kind = hash === 2 ? 'variables' : 'titles';
  return (
    <p>
      Used in {globalTooltipCount(entries.filter((entry) => entry.kind === kind))} tooltips.{' '}
      <Link to="/globals">Browse {kind} and jump to references</Link>.
    </p>
  );
}
