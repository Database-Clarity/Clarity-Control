import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Lang, Tooltip } from '@clarity/core';
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
import { LegacyHistorySection } from './LegacyHistory';
import styles from './History.module.scss';
import { isRelevant, projectHistory, viewScope, type HistoryScope } from './scope';

/**
 * One collapsed row: "Edited <date> by <author>, n revisions". Expanding it shows the commit list
 * with compare and Revert. The v2 list supplies the collapsed count; legacy history loads on open.
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
  const [revisions, setRevisions] = useState<{
    cache: RevisionCache;
    count: number;
    more: boolean;
  }>();
  const scope = useMemo(() => viewScope(language, readOnly), [language, readOnly]);
  const user = useAuthStore((state) => state.user);
  const tooltip = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const edit = lastEdit(
    projectHistory(draft?.next ?? tooltip ?? null, scope) ?? { hash, text: {}, associated: [] },
  );
  const signedIn = Boolean(apiUrl && user?.role);
  const cache = useRevisionCache(hash);
  useEffect(() => {
    if (suspended) {
      cache.cancelPending();
      return;
    }
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
  }, [cache, signedIn, open, suspended]);
  const recorded = revisions?.cache === cache ? revisions : undefined;
  const [scopedCount, setScopedCount] = useState<{
    cache: typeof cache;
    scope: HistoryScope;
    count: number;
    more: boolean;
  }>();
  useEffect(() => {
    if (!recorded || suspended || !signedIn) return;
    let active = true;
    let idle: number | undefined;
    const prepare = async () => {
      const entries = cache.peekPage(1) ?? [];
      let count = 0;
      for (let index = 0; index < entries.length; index++) {
        if (!active) return;
        const changes = await cache.classify(entries, index, 1, recorded.more);
        if (isRelevant(changes, scope)) count++;
      }
      if (active) setScopedCount({ cache, scope, count, more: recorded.more });
    };
    // Skip tooltips passed during a navigation burst; classify only after dwell,
    // or immediately when the user asks to open History.
    const timer = window.setTimeout(
      () => {
        if (window.requestIdleCallback && !open)
          idle = window.requestIdleCallback(() => void prepare().catch(() => undefined));
        else void prepare().catch(() => undefined);
      },
      open ? 0 : 150,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [recorded, cache, scope, suspended, signedIn, open]);
  const count =
    scopedCount?.cache === cache && scopedCount.scope === scope
      ? `${scopedCount.count}${scopedCount.more ? '+' : ''} revision${scopedCount.count === 1 && !scopedCount.more ? '' : 's'}`
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
  const [visibleCount, setVisibleCount] = useState(4);
  useEffect(() => {
    if (suspended || visibleCount >= commits.length) return;
    const frame = window.requestAnimationFrame(() =>
      setVisibleCount((count) => Math.min(count + 4, commits.length)),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [commits.length, visibleCount, suspended]);
  const [page, setPage] = useState(1);
  const [loadedPage, setLoadedPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
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
  }, [cache, page, attempt, suspended]);
  useEffect(() => {
    if (suspended || loading || !commits.length) return;
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
  }, [cache, commits, loading, suspended]);
  const [relevance, setRelevance] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      commits.flatMap((entry) => {
        const changes = cache.peekChanges(entry.commit);
        return changes ? [[entry.commit, isRelevant(changes, scope)]] : [];
      }),
    ),
  );
  const [classifying, setClassifying] = useState(false);
  useEffect(() => {
    if (suspended || loading) return;
    let active = true;
    setClassifying(true);
    void (async () => {
      for (let index = 0; index < commits.length; index++) {
        const changes = await cache.classify(commits, index, loadedPage, hasMore);
        if (!active) return;
        setRelevance((previous) => ({
          ...previous,
          [commits[index].commit]: isRelevant(changes, scope),
        }));
      }
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
  }, [cache, commits, loadedPage, hasMore, scope, suspended, loading, attempt]);
  const hidden = commits.filter((entry) => relevance[entry.commit] === false).length;
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
        <p>
          {hidden} {hidden === 1 ? 'change' : 'changes'} outside this view hidden
        </p>
      )}
      {classifying && <p role="status">Checking revision scope...</p>}
      <ol className={styles.commits}>
        {commits
          .slice(0, visibleCount)
          .map(
            (entry, index) =>
              relevance[entry.commit] === true && (
                <HistoryEntry
                  key={entry.commit}
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
                  canRestore={canRestore}
                  onRestore={restore}
                />
              ),
          )}
        {visibleCount < commits.length && <li role="status">Preparing remaining revisions...</li>}
      </ol>
      {loading && <p role="status">Loading commits...</p>}
      {!loading && !classifying && !commits.some((entry) => relevance[entry.commit]) && !error && (
        <p>No changes in this view.</p>
      )}
      {hasMore && !error && (
        <button type="button" disabled={loading} onClick={() => setPage((value) => value + 1)}>
          Load more commits
        </button>
      )}
    </section>
  );
}
