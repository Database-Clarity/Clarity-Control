import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { type HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { replaceDraft } from '../../services/save/drafts';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { HistoryEntry } from './HistoryEntry';
import { PanelRow } from '../../ui/PanelRow';
import { When } from '../../ui/When';
import { lastEdit } from './lastEdit';
import { itemFor } from '../navigation/catalog';
import { useRevisionCache, type RevisionCache } from './revisions';
import { revertDraft } from './revert';
import styles from './History.module.scss';

/**
 * One collapsed row: "Edited <date> by <author>, n revisions". Expanding it shows the commit list
 * with compare and Revert. The first page of commits loads with the row (it is the count), so
 * opening it is instant.
 */
export function HistoryPanel({ hash, readOnly = false }: { hash: number; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<{
    cache: RevisionCache;
    count: number;
    more: boolean;
  }>();
  const user = useAuthStore((state) => state.user);
  const tooltip = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const edit = lastEdit(draft?.next ?? tooltip ?? { hash, text: {}, associated: [] });
  const signedIn = Boolean(apiUrl && user?.role);
  const cache = useRevisionCache(hash);
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    void cache.page(1).then(
      (result) =>
        !controller.signal.aborted &&
        setRevisions((previous) =>
          previous?.cache === cache &&
          previous.count === result.length &&
          previous.more === (result.length === 30)
            ? previous
            : { cache, count: result.length, more: result.length === 30 },
        ),
      () => undefined,
    );
    return () => controller.abort();
  }, [cache, signedIn, open]);
  const recorded = revisions?.cache === cache ? revisions : undefined;
  const count = recorded
    ? `${recorded.count}${recorded.more ? '+' : ''} revision${recorded.count === 1 && !recorded.more ? '' : 's'}`
    : undefined;
  return (
    <PanelRow
      label="History"
      open={open}
      onOpenChange={setOpen}
      summary={
        edit.at !== undefined ? (
          <>
            Edited <When value={edit.at} nowrap /> by {edit.by ?? 'unknown author'}
            {count && `, ${count}`}
          </>
        ) : (
          (count ?? 'No recorded edits')
        )
      }
    >
      {!signedIn ? <p>Sign in as a configured member to view this tooltip's history.</p> : null}
      {signedIn && <HistoryContent key={`${hash}:${user?.id}`} hash={hash} readOnly={readOnly} />}
    </PanelRow>
  );
}

function HistoryContent({ hash, readOnly = false }: { hash: number; readOnly?: boolean }) {
  const user = useAuthStore((state) => state.user);
  const base = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const data = useDataStore((state) => state.data);
  const item = useMemo(() => (data ? itemFor(hash, data) : undefined), [hash, data]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const cache = useRevisionCache(hash);
  const [commits, setCommits] = useState<HistoryCommit[]>(() => cache.peekPage(1) ?? []);
  const [visibleCount, setVisibleCount] = useState(8);
  useEffect(() => {
    if (visibleCount >= commits.length) return;
    const frame = window.requestAnimationFrame(() =>
      setVisibleCount((count) => Math.min(count + 8, commits.length)),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [commits.length, visibleCount]);
  const [page, setPage] = useState(1);
  const [loadedPage, setLoadedPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void cache.page(page).then(
      (result) => {
        if (controller.signal.aborted) return;
        setCommits((previous) =>
          page === 1
            ? result
            : [
                ...previous.filter((entry) => !result.some((next) => next.commit === entry.commit)),
                ...result,
              ],
        );
        setLoadedPage(page);
        setHasMore(result.length === 30);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [cache, page, attempt]);
  useEffect(() => {
    if (loading || !commits.length) return;
    let idle: number | undefined;
    const prefetch = () => {
      for (const entry of commits.slice(0, 2))
        void cache.version(entry.commit).catch(() => undefined);
    };
    const timer = window.setTimeout(() => {
      if (window.requestIdleCallback) idle = window.requestIdleCallback(prefetch);
      else prefetch();
    }, 500);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [cache, commits, loading]);
  const current = draft?.next ?? base;
  const canRestore = !readOnly && hydrated && Boolean(base);

  const restore = useCallback(
    (version: Tooltip) => {
      setNotice(undefined);
      if (!base || !current || !user || !hydrated) return;
      replaceDraft(base, revertDraft(current, version, user));
      setNotice(
        'Historical version loaded as a local draft. Review it in the editor and use the normal save flow to commit it; nothing was saved or pushed automatically.',
      );
    },
    [base, current, user, hydrated],
  );

  return (
    <section aria-label={`History for ${hash}`}>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry history
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <ol className={styles.commits}>
        {commits.slice(0, visibleCount).map((entry, index) => (
          <HistoryEntry
            key={entry.commit}
            entry={entry}
            index={index}
            commits={commits}
            page={loadedPage}
            hasMore={hasMore}
            cache={cache}
            current={current}
            item={item}
            translator={user?.role === 'translator'}
            canRestore={canRestore}
            onRestore={restore}
          />
        ))}
        {visibleCount < commits.length && <li role="status">Preparing remaining revisions...</li>}
      </ol>
      {loading && <p role="status">Loading commits...</p>}
      {!loading && !commits.length && !error && <p>No commits found for this tooltip.</p>}
      {hasMore && !error && (
        <button type="button" disabled={loading} onClick={() => setPage((value) => value + 1)}>
          Load more commits
        </button>
      )}
    </section>
  );
}
