import { Link, useSearchParams } from 'react-router-dom';
import { plainError } from '../../services/httpError';
import { InlineAlert } from '../../ui/InlineAlert';
import type { QueueRow } from './queueRows';
import { useSharedSaves } from './sharedDecisions';
import styles from './CompendiumTab.module.scss';

/** Decisions for everyone that could not be saved; they stay shown as made until given up. */
export function SharedSaveError() {
  const error = useSharedSaves((state) => state.error);
  const count = useSharedSaves((state) => state.pending.size);
  const { retry, discard } = useSharedSaves.getState();
  if (!error || !count) return null;
  return (
    <InlineAlert onRetry={retry}>
      {count === 1 ? '1 decision' : `${count} decisions`} not saved for everyone:{' '}
      {plainError(error)}{' '}
      <button type="button" onClick={discard}>
        Discard
      </button>
    </InlineAlert>
  );
}

/** A maintainer's Not needed choices from before they applied to everyone: one click shares them. */
export function EarlierChoices({ rows }: { rows: readonly QueueRow[] }) {
  const [params] = useSearchParams();
  if (!rows.length) return null;
  const to = (hash: number) => {
    const next = new URLSearchParams(params);
    next.set('hash', String(hash));
    return `?${next}`;
  };
  return (
    <section className={styles.earlier} aria-label="Earlier Not needed choices">
      <p>
        <span className={styles.muted}>Not needed on this device only: </span>
        {rows.map((row, index) => (
          <span key={row.hash}>
            {index > 0 && ', '}
            <Link to={to(row.hash)}>{row.name}</Link>
          </span>
        ))}
      </p>
      <button
        type="button"
        onClick={() =>
          useSharedSaves.getState().set(
            rows.map((row) => row.hash),
            'not-needed',
          )
        }
      >
        Save {rows.length} earlier Not needed {rows.length === 1 ? 'choice' : 'choices'} for
        everyone
      </button>
    </section>
  );
}
