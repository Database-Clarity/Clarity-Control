import { useEffect, useState, type ReactNode } from 'react';
import { isMarkupOnly } from '@clarity/core';
import { getHistory, getVersion } from '../../services/history';
import { errorMessage } from '../../services/http';
import { WordDiff } from '../../ui/diff';
import { findTranslationSource, type TranslationSource } from './source';
import { MarkupOnlyEnglish } from './MarkupOnlyEnglish';
import styles from '../drift/Status.module.scss';
import { plainError } from '../../services/httpError';
import { InlineAlert } from '../../ui/InlineAlert';

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
  renderAfter,
}: {
  hash: number;
  sourceUpdatedAt: string;
  current: string;
  renderAfter?(text: string, offset: number): ReactNode;
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
        <InlineAlert onRetry={() => setRetry((value) => value + 1)} retryLabel="Retry history">
          History unavailable: {plainError(error)} Showing current English instead.
        </InlineAlert>
      )}
      {source?.kind === 'found' && source.text === current ? (
        <p>The English has not changed since this translation.</p>
      ) : source?.kind === 'found' && isMarkupOnly(source.text, current) ? (
        // A word diff of the raw markup would strike words that did not change: the current
        // English renders, with the newly tagged spans outlined.
        <MarkupOnlyEnglish before={source.text} current={current} hash={hash} />
      ) : source?.kind === 'found' ? (
        <>
          <p>
            English when translated → current English. Removed words are struck through; additions
            are underlined.
          </p>
          <WordDiff before={source.text} after={current} renderAfter={renderAfter} />
        </>
      ) : (
        (source || error) && (
          <>
            {source?.kind === 'missing' && (
              <p className={styles.muted}>{source.reason} Showing current English instead.</p>
            )}
            <h3>Current English (source diff unavailable)</h3>
            <p className={styles.text}>{renderAfter ? renderAfter(current, 0) : current}</p>
          </>
        )
      )}
    </section>
  );
}
