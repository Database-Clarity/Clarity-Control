import { isSetSelector } from '../compendium/itemClassification';
import { languageLabel } from '../../languageLabels';
import { useDeferredValue, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { translationQueue, type Tooltip, type TranslationQueueEntry } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { EnglishDiff } from './EnglishDiff';
import {
  availableLanguages,
  countStates,
  entryLabel,
  entryPath,
  filterQueue,
  nextEntry,
  parseWorklistFilter,
  worklistFilters,
  type WorklistFilter,
} from './worklist';
import styles from '../drift/Status.module.scss';

const pageSize = 50;
const filterLabels: Record<WorklistFilter, string> = {
  missing: 'Missing',
  outdated: 'Outdated',
  all: 'All',
};

function Cards({
  entries,
  nameOf,
}: {
  entries: readonly TranslationQueueEntry[];
  nameOf: (tooltip: Tooltip) => string;
}) {
  const [limit, setLimit] = useState(pageSize);
  return (
    <>
      <ul className={styles.worklist}>
        {entries.slice(0, limit).map((entry) => {
          const { tooltip, language, state } = entry;
          return (
            <li key={`${tooltip.hash}:${language}`} className={`${styles.card} ${styles.workCard}`}>
              <h2>
                <Link className={styles.cardLink} to={entryPath(entry)}>
                  {nameOf(tooltip)}
                </Link>{' '}
                <small>({tooltip.hash})</small>
              </h2>
              <p>
                <span className={styles.badge}>{languageLabel(language)}</span>{' '}
                <span className={state === 'missing' ? styles.warning : undefined}>
                  {state === 'missing' && 'Not translated yet'}
                  {state === 'current' && 'Up to date'}
                  {state === 'outdated' &&
                    (entry.exportedInEnglish
                      ? 'Over 90 days behind English — exported in English'
                      : `${Math.ceil((entry.ageMs ?? 0) / 86_400_000)} days behind English`)}
                </span>
              </p>
              <p className={`${styles.text} ${styles.clamp}`}>
                {state === 'missing' ? tooltip.text.en?.text : tooltip.text[language]?.text}
              </p>
              {state === 'outdated' && entry.sourceUpdatedAt && (
                <EnglishDiff
                  hash={tooltip.hash}
                  sourceUpdatedAt={entry.sourceUpdatedAt}
                  current={tooltip.text.en?.text ?? ''}
                />
              )}
            </li>
          );
        })}
      </ul>
      {entries.length > limit && (
        <button type="button" onClick={() => setLimit(limit + pageSize)}>
          Show more ({entries.length - limit} remaining)
        </button>
      )}
    </>
  );
}

export function TranslationsPage() {
  const data = useDataStore((state) => state.data);
  const { user, loading } = useAuthStore();
  const [params, setParams] = useSearchParams();
  const available = useMemo(() => availableLanguages(user), [user]);
  const language = params.get('lang') ?? 'all';
  const status = parseWorklistFilter(params.get('status'));
  const query = params.get('q') ?? '';
  const deferredQuery = useDeferredValue(query);
  const selected = useMemo(
    () => available.filter((lang) => language === 'all' || language === lang),
    [available, language],
  );
  const queue = useMemo(
    () =>
      data
        ? translationQueue(
            Object.values(data.bundle.tooltips).filter(
              (tooltip) => !data.items[tooltip.hash] || !isSetSelector(data.items[tooltip.hash]),
            ),
            selected,
            data.aliases,
          )
        : [],
    [data, selected],
  );
  const nameOf = useMemo(
    () => (tooltip: Tooltip) => entryLabel(tooltip, data?.items[tooltip.hash]?.name),
    [data],
  );
  const counts = useMemo(() => countStates(queue), [queue]);
  const visible = useMemo(
    () => filterQueue(queue, status, deferredQuery, nameOf),
    [queue, status, deferredQuery, nameOf],
  );
  const next = nextEntry(visible);
  if (loading) return <p role="status">Loading your translation languages...</p>;
  if (!data) return null;
  const update = (changes: Record<string, string | null>) => {
    const nextParams = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) nextParams.set(key, value);
      else nextParams.delete(key);
    }
    setParams(nextParams, { replace: true });
  };
  const translator = user?.role === 'translator';
  return (
    <article className={styles.page}>
      <h1>Translation worklist</h1>
      <p>
        Pick a tooltip to translate. <strong>Missing</strong> has no saved translation yet;{' '}
        <strong>Outdated</strong> is based on an older English revision (oldest gap first; red means
        the gap exceeds 90 days, so it is exported in English). Only tooltips with English text are
        listed. Local drafts are not included.
      </p>
      {translator && (
        <p>Your assigned languages: {available.map(languageLabel).join(', ') || 'none'}.</p>
      )}
      <div className={styles.filters}>
        <div role="group" aria-label="Translation status" className={styles.chips}>
          {worklistFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={status === filter}
              onClick={() => update({ status: filter === 'missing' ? null : filter })}
            >
              {filterLabels[filter]}
              {filter !== 'all' && ` (${counts[filter]})`}
            </button>
          ))}
        </div>
        <label>
          Language
          <select
            value={language}
            onChange={(event) =>
              update({ lang: event.target.value === 'all' ? null : event.target.value })
            }
          >
            <option value="all">{translator ? 'All assigned languages' : 'All languages'}</option>
            {available.map((lang) => (
              <option key={lang} value={lang}>
                {languageLabel(lang)}
              </option>
            ))}
            {language !== 'all' && !available.some((lang) => lang === language) && (
              <option value={language} disabled>
                Unavailable language ({languageLabel(language)})
              </option>
            )}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={query}
            placeholder="Name, hash or text"
            onChange={(event) => update({ q: event.target.value })}
          />
        </label>
      </div>
      <p role="status">
        {visible.length} {status === 'all' ? '' : `${filterLabels[status].toLowerCase()} `}
        translations in this view.{' '}
        {next && (
          <Link className={styles.next} to={entryPath(next)}>
            Open next
          </Link>
        )}
      </p>
      {!visible.length && (
        <p>
          {translator && !available.length
            ? 'You have no assigned languages, so there is nothing to translate.'
            : 'Nothing to show for these filters.'}
        </p>
      )}
      <Cards key={`${status}|${language}|${deferredQuery}`} entries={visible} nameOf={nameOf} />
    </article>
  );
}
