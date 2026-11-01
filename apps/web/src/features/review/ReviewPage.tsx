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
  const routedIndex = entries.findIndex(
    ({ tooltip }) => String(tooltip.hash) === searchParams.get('hash'),
  );
  const index = routedIndex < 0 ? 0 : routedIndex;
  const selectIndex = useCallback(
    (next: number | ((current: number) => number)) => {
      if (!entries.length) return;
      const requested = typeof next === 'function' ? next(index) : next;
      const entry = entries[stepIndex(requested, 0, entries.length)];
      if (!entry || searchParams.get('hash') === String(entry.tooltip.hash)) return;
      const params = new URLSearchParams(searchParams);
      params.set('hash', String(entry.tooltip.hash));
      setSearchParams(params, { replace: true });
    },
    [entries, index, searchParams, setSearchParams],
  );
  useEffect(() => {
    if (loading) return;
    setSidebarChanges(
      entries.map(({ tooltip, name, category }) => ({ hash: tooltip.hash, name, category })),
    );
  }, [entries, loading, setSidebarChanges]);
  useEffect(() => {
    const current = entries[index];
    if (!current || searchParams.get('hash') === String(current.tooltip.hash)) return;
    const params = new URLSearchParams(searchParams);
    params.set('hash', String(current.tooltip.hash));
    setSearchParams(params, { replace: true });
  }, [entries, index, searchParams, setSearchParams]);
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
      selectIndex((value) => stepIndex(value, event.key === 'ArrowDown' ? 1 : -1, entries.length));
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [entries.length, pushing, selectIndex]);
  const hashes = selectedPending(selected, entries);
  const start = Math.floor(index / pageSize) * pageSize;
  const page = entries.slice(start, start + pageSize);
  const groups = [...new Set(page.map((entry) => entry.category))];

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
      <h1>Review changes</h1>
      <p>
        Saved changes waiting to go live, grouped by category. Use Up/Down outside controls, or
        Previous/Next, to walk through them.
      </p>
      {Object.keys(drafts).length > 0 && (
        <p>Local drafts are not included. Save them through the tooltip editor first.</p>
      )}
      {!apiUrl || !user?.role ? (
        <p>
          Sign in as a configured member to compare live versions and browse history. Only editors
          and maintainers may push.
        </p>
      ) : null}
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
      {loading ? (
        <p role="status">Comparing publishable content...</p>
      ) : !entries.length ? (
        <p>No saved changes are waiting to go live.</p>
      ) : (
        <>
          <div className={styles.toolbar}>
            <button
              type="button"
              disabled={!index || pushing}
              onClick={() => selectIndex((value) => stepIndex(value, -1, entries.length))}
            >
              Previous
            </button>
            <span>
              {index + 1} of {entries.length}
            </span>
            <button
              type="button"
              disabled={index >= entries.length - 1 || pushing}
              onClick={() => selectIndex((value) => stepIndex(value, 1, entries.length))}
            >
              Next
            </button>
          </div>
          <div className={styles.workspace}>
            <section aria-label="Pending changes">
              <div className={styles.toolbar}>
                <button
                  type="button"
                  disabled={pushing}
                  onClick={() =>
                    setSelected(
                      (previous) =>
                        new Set([...previous, ...page.map(({ tooltip }) => tooltip.hash)]),
                    )
                  }
                >
                  Select page
                </button>
                <button type="button" disabled={pushing} onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </div>
              {groups.map((category) => (
                <section key={category}>
                  <h2>{category}</h2>
                  <ul className={styles.list}>
                    {page
                      .filter((entry) => entry.category === category)
                      .map((entry) => (
                        <ReviewRow
                          key={entry.tooltip.hash}
                          entry={entry}
                          checked={selected.has(entry.tooltip.hash)}
                          active={entries[index]?.tooltip.hash === entry.tooltip.hash}
                          disabled={pushing}
                          historyAvailable={Boolean(apiUrl && user?.role)}
                          onToggle={() =>
                            setSelected((previous) => toggleSelection(previous, entry.tooltip.hash))
                          }
                          onOpen={() => selectIndex(entries.indexOf(entry))}
                        />
                      ))}
                  </ul>
                </section>
              ))}
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
                  disabled={start + pageSize >= entries.length || pushing}
                  onClick={() => selectIndex(start + pageSize)}
                >
                  Next page
                </button>
              </div>
            </section>
            {entries[index] && user?.role && apiUrl && (
              <ReviewDetail key={entries[index].tooltip.hash} entry={entries[index]} />
            )}
          </div>
        </>
      )}
    </article>
  );
}
