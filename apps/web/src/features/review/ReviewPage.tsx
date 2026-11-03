import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import {
  canPush,
  pendingTooltips,
  publishableHashes,
  selectedPending,
  stepIndex,
  toggleSelection,
  type PendingTooltip,
} from './model';
import { ReviewDetail } from './ReviewDetail';
import { ReviewRow } from './ReviewRow';
import { acknowledgedMarkers, publishReviewed, useReviewSession } from './session';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import styles from './Review.module.scss';

const pageSize = 15;

export function ReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const data = useDataStore((state) => state.data);
  const load = useDataStore((state) => state.load);
  const user = useAuthStore((state) => state.user);
  const drafts = useDraftStore((state) => state.drafts);
  const setSidebarChanges = useSidebarQueueStore((state) => state.setPendingChanges);
  const [entries, setEntries] = useState<PendingTooltip[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const query = searchParams.get('query') ?? '';
  const categoryFilter = searchParams.get('category') ?? '';
  const { pushing, notice, error: pushError, acknowledgments } = useReviewSession();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    if (!data) return;
    setLoading(true);
    setSelected(new Set());
    void pendingTooltips(data, acknowledgedMarkers(data)).then(
      (result) => {
        if (!active) return;
        setEntries(result);
        setLoading(false);
      },
      (reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [data, acknowledgments]);
  const visibleEntries = entries.filter(
    ({ name, category, categoryId, tooltip }) =>
      (!categoryFilter || categoryId === categoryFilter) &&
      (!query ||
        `${name} ${category} ${categoryId} ${tooltip.hash}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const categories = [
    ...new Map(
      entries.map(({ category, categoryId }) => [categoryId, { id: categoryId, label: category }]),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const routedIndex = visibleEntries.findIndex(
    ({ tooltip }) => String(tooltip.hash) === searchParams.get('hash'),
  );
  const index = routedIndex < 0 ? 0 : routedIndex;
  const selectIndex = useCallback(
    (next: number | ((current: number) => number)) => {
      if (!visibleEntries.length) return;
      const requested = typeof next === 'function' ? next(index) : next;
      const entry = visibleEntries[stepIndex(requested, 0, visibleEntries.length)];
      if (!entry || searchParams.get('hash') === String(entry.tooltip.hash)) return;
      const params = new URLSearchParams(searchParams);
      params.set('hash', String(entry.tooltip.hash));
      setSearchParams(params, { replace: true });
    },
    [index, searchParams, setSearchParams, visibleEntries],
  );
  useEffect(() => {
    if (loading) return;
    setSidebarChanges(
      entries.map(({ tooltip, name, category }) => ({ hash: tooltip.hash, name, category })),
    );
  }, [entries, loading, setSidebarChanges]);
  useEffect(() => {
    if (loading) return;
    const current = visibleEntries[index];
    const params = new URLSearchParams(searchParams);
    if (!current) {
      if (!params.has('hash')) return;
      params.delete('hash');
      setSearchParams(params, { replace: true });
      return;
    }
    if (searchParams.get('hash') === String(current.tooltip.hash)) return;
    params.set('hash', String(current.tooltip.hash));
    setSearchParams(params, { replace: true });
  }, [index, loading, searchParams, setSearchParams, visibleEntries]);
  useEffect(() => {
    setSelected(new Set());
  }, [user]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (workspaceShortcutsBlocked(event)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || pushing) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, button, a, [contenteditable="true"]')
      )
        return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      selectIndex((value) =>
        stepIndex(value, event.key === 'ArrowDown' ? 1 : -1, visibleEntries.length),
      );
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [pushing, selectIndex, visibleEntries.length]);
  const hashes = selectedPending(selected, entries);
  const start = Math.floor(index / pageSize) * pageSize;
  const page = visibleEntries.slice(start, start + pageSize);
  const groups = [...new Set(page.map((entry) => entry.categoryId))];

  function updateFilters(queryValue: string, categoryValue: string) {
    const params = new URLSearchParams(searchParams);
    if (queryValue) params.set('query', queryValue);
    else params.delete('query');
    if (categoryValue) params.set('category', categoryValue);
    else params.delete('category');
    const matching = entries.filter(
      ({ name, category, categoryId, tooltip }) =>
        (!categoryValue || categoryId === categoryValue) &&
        (!queryValue ||
          `${name} ${category} ${categoryId} ${tooltip.hash}`
            .toLowerCase()
            .includes(queryValue.toLowerCase())),
    );
    const currentHash = params.get('hash');
    if (!matching.some(({ tooltip }) => String(tooltip.hash) === currentHash)) {
      if (matching[0]) params.set('hash', String(matching[0].tooltip.hash));
      else params.delete('hash');
    }
    setSearchParams(params, { replace: true });
  }

  async function publish() {
    if (!data || loading) return;
    setError(undefined);
    const succeeded = await publishReviewed(
      entries.filter(({ tooltip }) => hashes.includes(tooltip.hash)),
      data,
      () => mounted.current,
    );
    if (succeeded && mounted.current) setSelected(new Set());
  }

  return (
    <article>
      <header className={styles.heading}>
        <h1>Review changes</h1>
        <p>
          Saved changes waiting to go live, grouped by category. Use Up/Down outside controls, or
          Previous/Next, to walk through them.
        </p>
      </header>
      {Object.keys(drafts).length > 0 && (
        <p>Local drafts are not included. Save them through the tooltip editor first.</p>
      )}
      {(!apiUrl || !user?.role) && (
        <p className={styles.authNotice} role="note">
          {apiUrl
            ? 'Sign in as a configured member to compare live versions and browse history. Only editors and maintainers may push.'
            : 'Live comparison and history need a configured API. Saved changes remain local.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {pushError && <p role="alert">{pushError}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className={styles.toolbar}>
        <button type="button" disabled={pushing || loading} onClick={() => void load()}>
          Refresh saved changes
        </button>
        <span>
          {entries.length} pending / {hashes.length} selected
        </span>
        {canPush(user) && (
          <button
            type="button"
            disabled={pushing || loading || !hashes.length || hashes.length > 100}
            onClick={() => void publish()}
          >
            {pushing ? 'Pushing...' : 'Push selected'}
          </button>
        )}
        {hashes.length > 100 && <span role="alert">Select at most 100 tooltips per push.</span>}
      </div>
      {!!entries.length && (
        <div className={styles.filters}>
          <label>
            Find saved changes
            <input
              type="search"
              aria-label="Find saved changes"
              value={query}
              onChange={(event) => updateFilters(event.target.value, categoryFilter)}
              placeholder="Name, category or hash"
            />
          </label>
          <label>
            Category
            <select
              aria-label="Category"
              value={categoryFilter}
              onChange={(event) => updateFilters(query, event.target.value)}
            >
              <option value="">All categories</option>
              {categories.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label} · {id}
                </option>
              ))}
            </select>
          </label>
          <span>
            Showing {visibleEntries.length} of {entries.length}
          </span>
        </div>
      )}
      {loading ? (
        <p role="status">Comparing publishable content...</p>
      ) : !entries.length ? (
        <p>No saved changes are waiting to go live.</p>
      ) : !visibleEntries.length ? (
        <section className={styles.empty}>
          <p>No saved changes match these filters.</p>
          <button type="button" onClick={() => updateFilters('', '')}>
            Clear filters
          </button>
        </section>
      ) : (
        <>
          <div className={styles.toolbar}>
            <button
              type="button"
              disabled={!index || pushing}
              onClick={() => selectIndex((value) => stepIndex(value, -1, visibleEntries.length))}
            >
              Previous
            </button>
            <span>
              {index + 1} of {visibleEntries.length}
            </span>
            <button
              type="button"
              disabled={index >= visibleEntries.length - 1 || pushing}
              onClick={() => selectIndex((value) => stepIndex(value, 1, visibleEntries.length))}
            >
              Next
            </button>
          </div>
          <div className={styles.workspace}>
            <section className={styles.card} aria-label="Pending changes">
              <header className={styles.listHeading}>
                <h2>Pending changes</h2>
                <div className={styles.toolbar}>
                  <button
                    type="button"
                    disabled={pushing}
                    onClick={() =>
                      setSelected((previous) => new Set([...previous, ...publishableHashes(page)]))
                    }
                  >
                    Select page
                  </button>
                  <button type="button" disabled={pushing} onClick={() => setSelected(new Set())}>
                    Clear selection
                  </button>
                </div>
              </header>
              {groups.map((categoryId) => {
                const category = page.find((entry) => entry.categoryId === categoryId)!;
                return (
                  <section key={categoryId} aria-label={`${category.category} (${categoryId})`}>
                    <h3 className={styles.categoryHeading}>
                      {category.category} <small>· {categoryId}</small>
                    </h3>
                    <ul className={styles.list}>
                      {page
                        .filter((entry) => entry.categoryId === categoryId)
                        .map((entry) => (
                          <ReviewRow
                            key={entry.tooltip.hash}
                            entry={entry}
                            checked={selected.has(entry.tooltip.hash)}
                            active={visibleEntries[index]?.tooltip.hash === entry.tooltip.hash}
                            disabled={pushing}
                            historyAvailable={Boolean(apiUrl && user?.role)}
                            onToggle={() =>
                              setSelected((previous) =>
                                toggleSelection(previous, entry.tooltip.hash),
                              )
                            }
                            onOpen={() => selectIndex(visibleEntries.indexOf(entry))}
                          />
                        ))}
                    </ul>
                  </section>
                );
              })}
              <div className={styles.toolbar}>
                <button
                  type="button"
                  disabled={!start || pushing}
                  onClick={() => selectIndex(start - pageSize)}
                >
                  Previous page
                </button>
                <button
                  type="button"
                  disabled={start + pageSize >= visibleEntries.length || pushing}
                  onClick={() => selectIndex(start + pageSize)}
                >
                  Next page
                </button>
              </div>
            </section>
            {visibleEntries[index] && user?.role && apiUrl && (
              <div className={styles.card}>
                <ReviewDetail
                  key={visibleEntries[index].tooltip.hash}
                  entry={visibleEntries[index]}
                />
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}
