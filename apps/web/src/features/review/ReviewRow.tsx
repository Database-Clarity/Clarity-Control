import { useEffect, useState } from 'react';
import { getHistory, type HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { CommitAuthor } from '../history/CommitAuthor';
import type { PendingTooltip } from './model';
import styles from './Review.module.scss';

export function ReviewRow({
  entry,
  checked,
  active,
  onToggle,
  onOpen,
  disabled,
  historyAvailable,
}: {
  entry: PendingTooltip;
  checked: boolean;
  active: boolean;
  onToggle(): void;
  onOpen(): void;
  disabled: boolean;
  historyAvailable: boolean;
}) {
  const [latest, setLatest] = useState<HistoryCommit>();
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!historyAvailable) return;
    const controller = new AbortController();
    setLatest(undefined);
    setError(undefined);
    setLoaded(false);
    void getHistory(entry.tooltip.hash, 1, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setLatest(result.commits[0]);
          setLoaded(true);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [entry.tooltip, historyAvailable]);
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={disabled}
          aria-label={`Select ${entry.name}, ${entry.category}, ${entry.tooltip.hash}`}
        />{' '}
        <button
          type="button"
          onClick={onOpen}
          aria-current={active ? 'true' : undefined}
          aria-label={`Open ${entry.name}, ${entry.category}, ${entry.tooltip.hash}`}
        >
          <span className={styles.rowIdentity}>
            {entry.name} <small>#{entry.tooltip.hash}</small>
          </span>
        </button>
      </label>
      {historyAvailable && (
        <div>
          {latest ? (
            <CommitAuthor entry={latest} />
          ) : error ? (
            <span role="alert">{error}</span>
          ) : (
            <span>{loaded ? 'No history available' : 'Loading latest change...'}</span>
          )}
        </div>
      )}
    </li>
  );
}
