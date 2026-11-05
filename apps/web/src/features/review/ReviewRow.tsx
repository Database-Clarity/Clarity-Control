import { memo, useEffect, useRef, useState } from 'react';
import { getHistory, type HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { CommitAuthor } from '../history/CommitAuthor';
import type { PendingTooltip } from './model';
import styles from './Review.module.scss';

export const ReviewRow = memo(function ReviewRow({
  entry,
  checked,
  active,
  onToggle,
  onOpen,
  disabled,
  publishing = false,
  historyAvailable,
}: {
  entry: PendingTooltip;
  checked: boolean;
  active: boolean;
  onToggle(hash: number): void;
  onOpen(hash: number): void;
  disabled: boolean;
  /** Part of a publish that is still queued or being sent: cannot be selected again. */
  publishing?: boolean;
  historyAvailable: boolean;
}) {
  const [latest, setLatest] = useState<HistoryCommit>();
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const near = useRef(false);
  useEffect(() => {
    if (!historyAvailable) return;
    const controller = new AbortController();
    const load = () => {
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
    };
    if (near.current || typeof IntersectionObserver === 'undefined') {
      near.current = true;
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          near.current ||
          controller.signal.aborted ||
          !entries.some((entry) => entry.isIntersecting)
        )
          return;
        near.current = true;
        observer.disconnect();
        // Proximity starts the request directly; it has no visible state of its
        // own and does not need an extra React render/effect for every row.
        load();
      },
      { rootMargin: '200px' },
    );
    observer.observe(row.current!);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [entry.tooltip, historyAvailable]);
  return (
    <li ref={row}>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(entry.tooltip.hash)}
          disabled={disabled || publishing || Boolean(entry.unpublishable)}
          title={entry.unpublishable ?? (publishing ? 'Publishing…' : undefined)}
          aria-label={`Select ${entry.name}, ${entry.category}, ${entry.tooltip.hash}`}
        />{' '}
        <button
          type="button"
          data-perf-navigation="true"
          onClick={() => onOpen(entry.tooltip.hash)}
          aria-current={active ? 'true' : undefined}
          aria-label={`Open ${entry.name}, ${entry.category}, ${entry.tooltip.hash}`}
          title={[
            `${entry.name} #${entry.tooltip.hash}`,
            entry.unpublishable && `Unpublishable: ${entry.unpublishable}`,
            publishing && 'Publishing…',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <span className={styles.rowIdentity}>
            {entry.name} <small>#{entry.tooltip.hash}</small>
            {entry.unpublishable && <small> · unpublishable: no generator entry</small>}
            {publishing && <small> · publishing…</small>}
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
});
