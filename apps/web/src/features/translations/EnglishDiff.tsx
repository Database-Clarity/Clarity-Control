import { useEffect, useState } from 'react';
import { isMarkupOnly } from '@clarity/core';
import { getHistory, getVersion } from '../../services/history';
import { errorMessage } from '../../services/http';
import { WordDiff } from '../../ui/diff';
import { findTranslationSource, type TranslationSource } from './source';
import styles from '../drift/Status.module.scss';

export function EnglishDiff({
  hash,
  sourceUpdatedAt,
  current,
}: {
  hash: number;
  sourceUpdatedAt: string;
  current: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Hide English changes' : 'Show English changes'}
      </button>
      {expanded && (
        <EnglishDiffContent hash={hash} sourceUpdatedAt={sourceUpdatedAt} current={current} />
      )}
    </div>
  );
}

export function EnglishDiffContent({
  hash,
  sourceUpdatedAt,
  current,
}: {
  hash: number;
  sourceUpdatedAt: string;
  current: string;
}) {
  const [source, setSource] = useState<TranslationSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSource(null);
    setError(null);
    void findTranslationSource(hash, sourceUpdatedAt, { getHistory, getVersion }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSource(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [hash, sourceUpdatedAt, retry]);
  return (
    <section aria-label="English source changes">
      {!source && !error && <p role="status">Finding the English source in history...</p>}
      {error && (
        <p role="alert">
          History unavailable: {error} Showing current English instead.{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry history
          </button>
        </p>
      )}
      {source?.kind === 'found' && isMarkupOnly(source.text, current) ? (
        <>
          <p data-markup-only>
            <strong>Markup only:</strong> the English words did not change; only element tags (an
            icon grouped with its words) were added, changed, or removed.
          </p>
          <WordDiff before={source.text} after={current} />
        </>
      ) : source?.kind === 'found' ? (
        <>
          <p>
            English when translated → current English. Removed words are struck through; additions
            are underlined.
          </p>
          <WordDiff before={source.text} after={current} />
        </>
      ) : (
        (source || error) && (
          <>
            {source?.kind === 'missing' && (
              <p className={styles.muted}>{source.reason} Showing current English instead.</p>
            )}
            <h3>Current English (source diff unavailable)</h3>
            <p className={styles.text}>{current}</p>
          </>
        )
      )}
    </section>
  );
}
