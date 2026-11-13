import { isSetSelector } from '../compendium/itemClassification';
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { bungieDrift, type Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { When } from '../../ui/When';
import { canEditTooltipFields } from '../auth/permissions';
import { reviewedSnapshot } from './review';
import type { DriftRestore } from '../queue/sources';
import { returnedState, useRestoredScroll, WorkThroughBar } from '../queue/WorkThroughBar';
import bar from '../queue/WorkThroughBar.module.scss';
import styles from './Status.module.scss';

export function DriftPage() {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  // Leave from a work-through queue brings the filter, selection, and scroll back.
  const returned = returnedState<DriftRestore>(useLocation().state);
  const [query, setQuery] = useState(returned?.query ?? '');
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(returned?.selected ?? []),
  );
  const anchor = useRef<HTMLDivElement>(null);
  useRestoredScroll(anchor, returned?.scroll, Boolean(data));
  const locked = useSaveState((state) => state.locked);
  const [error, setError] = useState<string | null>(null);
  const result = useMemo(
    () =>
      data &&
      bungieDrift(
        Object.values(data.bundle.tooltips).filter(
          (tooltip) => !data.items[tooltip.hash] || !isSetSelector(data.items[tooltip.hash]),
        ),
        data.items,
        data.aliases,
      ),
    [data],
  );
  const canReview = Boolean(apiUrl && canEditTooltipFields(user));
  if (!data || !result) return <div ref={anchor} />;
  const search = query.trim().toLocaleLowerCase();
  const entries = result.changed.filter(
    ({ tooltip }) =>
      String(tooltip.hash).includes(search) ||
      data.items[tooltip.hash]?.name.toLocaleLowerCase().includes(search),
  );

  const queueItems = entries.map(({ tooltip }) => ({
    key: String(tooltip.hash),
    hash: tooltip.hash,
    name: data.items[tooltip.hash]?.name ?? String(tooltip.hash),
  }));
  function toggle(hash: number, on: boolean) {
    setSelected((old) => {
      const next = new Set(old);
      if (on) next.add(hash);
      else next.delete(hash);
      return next;
    });
  }

  function markReviewed(base: Tooltip, description: string) {
    setError(null);
    try {
      const next = reviewedSnapshot(base, description, new Date().toISOString());
      reviewSaveChanges([{ hash: base.hash, base, next }]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <article className={styles.page}>
      <h1>Bungie drift</h1>
      <p>{result.changed.length} changed in-game descriptions.</p>
      <p className={styles.muted}>
        Saved manifest tooltips without a snapshot: {result.missingSnapshots} (not listed). English
        edits create snapshots for future comparisons. This view uses saved tooltips, not local
        drafts.
      </p>
      <p>Removed words are struck through; added words are underlined.</p>
      {!canReview && (
        <p className={styles.muted}>
          Sign in as a maintainer, editor or trial editor to mark descriptions reviewed.
        </p>
      )}
      <div className={styles.filters} ref={anchor}>
        <label>
          Filter by name or hash
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <WorkThroughBar
        source="drift"
        selected={queueItems.filter((item) => selected.has(item.hash))}
        shown={queueItems}
        restore={{ query, selected: [...selected] } satisfies Omit<DriftRestore, 'scroll'>}
        onClear={() => setSelected(new Set())}
        anchor={anchor}
      />
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void useDataStore.getState().load()}>
            Reload editor data
          </button>
        </p>
      )}
      {!entries.length && <p>No changed descriptions{query ? ' match this filter' : ''}.</p>}
      {entries.map(({ tooltip, description }) => (
        <section key={tooltip.hash} className={styles.card}>
          <h2 className={styles.cardTitle}>
            <label className={bar.select}>
              <input
                type="checkbox"
                checked={selected.has(tooltip.hash)}
                aria-label={`Select ${data.items[tooltip.hash]?.name ?? tooltip.hash}`}
                onChange={(event) => toggle(tooltip.hash, event.target.checked)}
              />
            </label>
            <Link to={`/t/${tooltip.hash}`}>{data.items[tooltip.hash]?.name ?? tooltip.hash}</Link>{' '}
            <small>({tooltip.hash})</small>
          </h2>
          <p className={styles.muted}>
            Snapshot: <When value={tooltip.bungieSnapshot?.snapshotAt} fallback="none" />
          </p>
          <WordDiff before={tooltip.bungieSnapshot?.description ?? ''} after={description} />
          <button
            type="button"
            disabled={!canReview || locked}
            onClick={() => markReviewed(tooltip, description)}
          >
            Mark reviewed
          </button>
        </section>
      ))}
    </article>
  );
}
