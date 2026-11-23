import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { plainError } from '../../services/httpError';
import { InlineAlert } from '../../ui/InlineAlert';
import type { QueueRow } from './queueRows';
import { useSharedSaves, useUnsaved } from './sharedDecisions';
import styles from './CompendiumTab.module.scss';

/** Decisions for everyone that could not be saved; they stay shown as made until given up. */
export function SharedSaveError() {
  const { pending, error } = useUnsaved();
  const count = pending.size;
  const { retry, discard } = useSharedSaves.getState();
  if (!error || !count) return null;
  return (
    <InlineAlert
      onRetry={retry}
      action={
        <button type="button" onClick={discard}>
          Discard
        </button>
      }
    >
      {count === 1 ? '1 decision' : `${count} decisions`} not saved for everyone:{' '}
      {plainError(error)}
    </InlineAlert>
  );
}

/**
 * A maintainer's Not needed choices from before they applied to everyone: one click shares the
 * ticked ones. Rows that have a confident match now start unticked, so none is hidden by accident.
 */
export function EarlierChoices({ rows }: { rows: readonly QueueRow[] }) {
  const [params] = useSearchParams();
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  if (!rows.length) return null;
  const ticked = rows.filter((row) => flipped.has(row.hash) === !!row.matches);
  const noun = ticked.length === 1 ? 'choice' : 'choices';
  const to = (hash: number) => {
    const next = new URLSearchParams(params);
    next.set('hash', String(hash));
    return `?${next}`;
  };
  const flip = (hash: number) =>
    setFlipped((old) => {
      const next = new Set(old);
      if (!next.delete(hash)) next.add(hash);
      return next;
    });
  return (
    <section className={styles.earlier} aria-label="Earlier Not needed choices">
      <h2 className={styles.earlierTitle}>Not needed on this device only</h2>
      <button
        type="button"
        disabled={!ticked.length}
        aria-label={`Save ${ticked.length} earlier Not needed ${noun} for everyone`}
        onClick={() =>
          useSharedSaves.getState().set(
            ticked.map((row) => row.hash),
            'not-needed',
          )
        }
      >
        Save {ticked.length}
        <span className={styles.earlierWords}> earlier Not needed {noun}</span> for everyone
      </button>
      <div className={styles.earlierList}>
        {rows.map((row) => (
          <span key={row.hash} className={styles.earlierChoice}>
            <input
              type="checkbox"
              aria-label={`Save ${row.name} for everyone`}
              checked={ticked.includes(row)}
              onChange={() => flip(row.hash)}
            />
            <Link to={to(row.hash)}>{row.name}</Link>
            {row.matches && <span className={styles.earlierMatch}>matched now</span>}
          </span>
        ))}
      </div>
    </section>
  );
}
