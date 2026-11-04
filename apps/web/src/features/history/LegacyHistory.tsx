import { useEffect, useMemo, useState } from 'react';
import type { Tooltip } from '@clarity/core';
import {
  getLegacyHistory,
  legacyRevisionCache,
  type LegacyHistory as History,
  type LegacyLane,
} from '../../services/legacyHistory';
import { HistoryEntry } from './HistoryEntry';
import styles from './History.module.scss';

export function LegacyHistory({
  hash,
  current,
  canRestore,
  translator,
  onRestore,
}: {
  hash: number;
  current?: Tooltip;
  canRestore: boolean;
  translator: boolean;
  onRestore(version: Tooltip): void;
}) {
  const [history, setHistory] = useState<History | null>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setHistory(undefined);
    setError(false);
    void getLegacyHistory(hash, controller.signal).then(
      (value) => active && setHistory(value),
      () => active && setError(true),
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [hash, attempt]);
  return (
    <section aria-label="Published before migration">
      <h4>Published before migration</h4>
      {error ? (
        <p>
          Published history is unavailable offline or could not be loaded.{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry published history
          </button>
        </p>
      ) : history === undefined ? (
        <p role="status">Loading published history...</p>
      ) : history === null ? (
        <p>No published history available for this tooltip.</p>
      ) : (
        history.lanes.map((lane) => (
          <Lane
            key={lane.sourceHash}
            lane={lane}
            current={current}
            canRestore={canRestore && lane.verified}
            translator={translator}
            onRestore={onRestore}
          />
        ))
      )}
    </section>
  );
}

function Lane({
  lane,
  current,
  canRestore,
  translator,
  onRestore,
}: {
  lane: LegacyLane;
  current?: Tooltip;
  canRestore: boolean;
  translator: boolean;
  onRestore(version: Tooltip): void;
}) {
  const cache = useMemo(() => legacyRevisionCache(lane), [lane]);
  const commits = cache.peekPage(1)!;
  const [count, setCount] = useState(4);
  return (
    <>
      <p>
        Published source <code>{lane.sourceHash}</code>
        {!lane.verified && ' · Alias history (restore unavailable)'}
      </p>
      <ol className={styles.commits}>
        {commits.slice(0, count).map((entry, index) => (
          <HistoryEntry
            key={entry.commit}
            entry={entry}
            index={index}
            commits={commits}
            page={1}
            hasMore={false}
            cache={cache}
            current={current}
            translator={translator}
            legacy
            canRestore={canRestore}
            onRestore={onRestore}
          />
        ))}
      </ol>
      {count < commits.length && (
        <button type="button" onClick={() => setCount((n) => n + 8)}>
          Load more published revisions
        </button>
      )}
    </>
  );
}
