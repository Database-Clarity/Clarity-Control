import { LoadingSkeleton } from '../../ui/Skeleton';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Lang, Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { type HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { replaceDraft } from '../../services/save/drafts';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { HistoryEntry, type HistoryEntryProps } from './HistoryEntry';
import {
  SkeletonRegion,
  SkeletonRows,
  SkeletonStatus,
  useSkeletonVisible,
} from '../../ui/Skeleton';
import { PanelRow } from '../../ui/PanelRow';
import { When } from '../../ui/When';
import { lastEdit } from './lastEdit';
import { itemFor } from '../navigation/catalog';
import { useRevisionCache } from './revisions';
import { revertDraft } from './revert';
import { LegacyHistorySection } from './LegacyHistory';
import styles from './History.module.scss';
import {
  isRelevant,
  noImpactFromTrailer,
  projectHistory,
  viewScope,
  type HistoryScope,
} from './scope';

/**
 * One collapsed row: "Edited <date> by <author>, n revisions". Expanding it shows the commit list
 * with compare and Restore. Metadata may prefetch; revision bodies load only while open.
 * `attribution` is the open language's own last edit and legacy upload, shown above the commits.
 */
export function HistoryPanel({
  hash,
  readOnly = false,
  suspended = false,
  attribution,
  language = 'en',
}: {
  language?: Lang;
  hash: number;
  readOnly?: boolean;
  suspended?: boolean;
  attribution?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const scope = useMemo(() => viewScope(language, readOnly), [language, readOnly]);
  const user = useAuthStore((state) => state.user);
  const tooltip = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const value = draft?.next ?? tooltip;
  const shown = projectHistory(value ?? null, scope) ?? { hash, text: {}, associated: [] };
  const edit = lastEdit(language === 'en' ? { ...shown, legacy: value?.legacy } : shown);
  const signedIn = Boolean(apiUrl && user?.role);
  const cache = useRevisionCache(hash);
  useEffect(() => {
    if (suspended) {
      cache.cancelPending();
      return;
    }
    if (!signedIn) return;
    void cache.page(1).catch(() => undefined);
  }, [cache, signedIn, suspended]);
  useEffect(() => () => cache.cancelPending(), [cache]);
  return (
    <PanelRow
      label="History"
      open={open}
      onOpenChange={(next) => {
        if (!next) cache.cancelPending();
        setOpen(next);
      }}
      summary={
        edit.at !== undefined ? (
          <>
            Edited <When value={edit.at} nowrap /> by {edit.by ?? 'unknown author'}
          </>
        ) : undefined
      }
    >
      {attribution}
      {!signedIn ? <p>Sign in as a configured member to view v2 history.</p> : null}
      {signedIn && (
        <HistoryContent
          key={`v2-${cache.identity}-${language}-${readOnly}`}
          scope={scope}
          hash={hash}
          readOnly={readOnly}
          suspended={suspended}
        />
      )}
      {language === 'en' && (
        <LegacyHistorySection
          key={`legacy-${user?.id}-${user?.role}`}
          hash={hash}
          readOnly={readOnly}
        />
      )}
    </PanelRow>
  );
}

function HistoryContent({
  scope,
  hash,
  readOnly = false,
  suspended = false,
}: {
  hash: number;
  readOnly?: boolean;
  suspended?: boolean;
  scope: HistoryScope;
}) {
  const user = useAuthStore((state) => state.user);
  const base = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const data = useDataStore((state) => state.data);
  const item = useMemo(() => (data ? itemFor(hash, data) : undefined), [hash, data]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const cache = useRevisionCache(hash);
  const [commits, setCommits] = useState<HistoryCommit[]>(() => cache.peekPage(1) ?? []);
  // One viewport-sized group, plus one group ahead. API pages stay unchanged.
  const windowSize = 8;
  const [visibleCount, setVisibleCount] = useState(windowSize);
  const sentinel = useRef<HTMLLIElement>(null);
  const prefetchedWindow = useRef<number>();
  const [page, setPage] = useState(1);
  const pageStart = useRef({ page: 1, count: 0 });
  if (pageStart.current.page !== page) pageStart.current = { page, count: commits.length };
  const [loadedPage, setLoadedPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const loadingSkeleton = useSkeletonVisible(loading && !error, cache, true);
  const [notice, setNotice] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (suspended) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void cache.page(page).then(
      (result) => {
        if (controller.signal.aborted) return;
        // Hints and completed cache entries never flash a skeleton on a new page.
        setRelevance((previous) => ({
          ...previous,
          ...Object.fromEntries(
            result.flatMap((entry) => {
              const changes = cache.peekChanges(entry);
              return changes ? [[entry.commit, isRelevant(changes, scope)]] : [];
            }),
          ),
        }));
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
  }, [cache, page, attempt, suspended, scope]);
  const [relevance, setRelevance] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      commits.flatMap((entry) => {
        const changes = cache.peekChanges(entry);
        return changes ? [[entry.commit, isRelevant(changes, scope)]] : [];
      }),
    ),
  );
  const [classifying, setClassifying] = useState(false);
  useEffect(() => {
    if (suspended || loading) return;
    let active = true;
    setClassifying(true);
    const limit = Math.min(commits.length, visibleCount + windowSize);
    const classifyGroup = async (start: number, end: number) => {
      let nextIndex = start;
      const run = async () => {
        while (active && nextIndex < end) {
          const index = nextIndex++;
          const changes = await cache.classify(commits, index, loadedPage, hasMore);
          if (!active) return;
          setRelevance((previous) => ({
            ...previous,
            [commits[index].commit]: isRelevant(changes, scope),
          }));
        }
      };
      await Promise.all(Array.from({ length: 4 }, run));
    };
    void (async () => {
      const visibleEnd = Math.min(visibleCount, limit);
      await classifyGroup(0, visibleEnd);
      if (active) await classifyGroup(visibleEnd, limit);
      if (active) setClassifying(false);
    })().catch((reason: unknown) => {
      if (active) {
        setError(errorMessage(reason));
        setClassifying(false);
      }
    });
    return () => {
      active = false;
    };
  }, [cache, commits, loadedPage, hasMore, scope, suspended, loading, attempt, visibleCount]);
  useEffect(() => {
    if (suspended || typeof IntersectionObserver === 'undefined' || !sentinel.current) return;
    const root = sentinel.current.closest('[data-open]')?.lastElementChild;
    if (!root) return;
    let scrolled = false;
    let nearEnd = false;
    const advance = () => {
      if (scrolled && nearEnd) {
        scrolled = false;
        setVisibleCount((count) => count + windowSize);
      }
    };
    const onScroll = () => {
      scrolled = true;
      advance();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        nearEnd = Boolean(entry?.isIntersecting);
        advance();
      },
      { root },
    );
    root.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(sentinel.current);
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', onScroll);
    };
  }, [visibleCount, commits.length, suspended]);
  useEffect(() => {
    if (
      !suspended &&
      !loading &&
      hasMore &&
      visibleCount + windowSize > commits.length &&
      prefetchedWindow.current !== visibleCount
    ) {
      prefetchedWindow.current = visibleCount;
      setPage((value) => value + 1);
    }
  }, [visibleCount, commits.length, suspended, loading, hasMore]);
  const range = commits.slice(0, visibleCount);
  const knownRange =
    range.length > 0 && range.every((entry) => relevance[entry.commit] !== undefined);
  const hidden = knownRange ? range.filter((entry) => relevance[entry.commit] === false).length : 0;
  const current = draft?.next ?? base;
  const canRestore =
    !readOnly &&
    hydrated &&
    Boolean(base) &&
    Boolean(user?.role) &&
    (user?.role !== 'translator' ||
      scope.languages.some((language) => language !== 'en' && user.languages?.includes(language)));

  const restore = useCallback(
    (version: Tooltip) => {
      setNotice(undefined);
      if (!base || !current || !user || !hydrated) return;
      replaceDraft(base, revertDraft(current, version, user, scope));
      setNotice(
        'Historical version loaded as a local draft. Review it in the editor and use the normal save flow to commit it; nothing was saved or pushed automatically.',
      );
    },
    [base, current, user, hydrated, scope],
  );

  return (
    <section aria-label={`History for ${hash}`} className={styles.historySection}>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry history
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {hidden > 0 && (
        <p className={styles.hiddenCount} title="Only changes relevant to this view are listed.">
          {hidden} {hidden === 1 ? 'change' : 'changes'} hidden in this view
        </p>
      )}
      {classifying && <p role="status">Checking revision scope...</p>}
      <ol
        hidden={page === 1 && !error && (loading || loadingSkeleton)}
        style={
          page === 1 && !error && (loading || loadingSkeleton) ? { display: 'none' } : undefined
        }
        className={styles.commits}
        aria-busy={
          loading ||
          commits.slice(0, visibleCount).some((entry) => relevance[entry.commit] === undefined)
        }
      >
        {commits
          .slice(
            0,
            page > 1 && (loading || loadingSkeleton)
              ? Math.min(visibleCount, pageStart.current.count)
              : visibleCount,
          )
          .map((entry, index) => (
            <ScopedHistoryEntry
              key={entry.commit}
              relevant={relevance[entry.commit]}
              scope={scope}
              entry={entry}
              index={index}
              commits={commits}
              page={loadedPage}
              hasMore={hasMore}
              cache={cache}
              current={current}
              item={item}
              translator={user?.role === 'translator'}
              noTranslationImpact={noImpactFromTrailer(entry.message, hash)}
              canRestore={canRestore}
              onRestore={restore}
            />
          ))}
        {visibleCount < commits.length && (
          <li ref={sentinel} aria-hidden="true" data-history-more="true" />
        )}
      </ol>
      {!error && (loading || loadingSkeleton) && (
        <LoadingSkeleton label="Loading commits..." shape="rows" visible={loadingSkeleton} />
      )}

      {!loading &&
        !classifying &&
        (!commits.length || knownRange) &&
        !range.some((entry) => relevance[entry.commit]) &&
        !error && <p>No relevant changes in these revisions.</p>}
      {visibleCount < commits.length && (
        <button type="button" onClick={() => setVisibleCount((count) => count + windowSize)}>
          Show older revisions
        </button>
      )}
      {visibleCount >= commits.length && hasMore && !error && (
        <button type="button" disabled={loading} onClick={() => setPage((value) => value + 1)}>
          Load more commits
        </button>
      )}
    </section>
  );
}

function ScopedHistoryEntry({
  relevant,
  ...props
}: HistoryEntryProps & { relevant: boolean | undefined }) {
  const skeleton = useSkeletonVisible(
    relevant === undefined,
    props.entry.commit,
    relevant !== undefined,
  );
  if (skeleton)
    return (
      <li data-history-pending="true">
        <SkeletonRegion>
          <SkeletonRows count={1} columns={[65, 35]} rowHeight="3rem" />
        </SkeletonRegion>
        <SkeletonStatus>Checking revision scope</SkeletonStatus>
      </li>
    );
  return relevant ? <HistoryEntry {...props} /> : null;
}
