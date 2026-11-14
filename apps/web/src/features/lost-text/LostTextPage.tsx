import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import artifact from './lost-text.json';
import {
  artifactSchema,
  canRecover,
  fingerprint,
  recordKey,
  recoveryDraft,
  visibleRecords,
} from './model';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { replaceDraft } from '../../services/save/drafts';
import { errorMessage } from '../../services/http';
import { When } from '../../ui/When';
import type { LostRestore } from '../queue/sources';
import { lostItem } from '../queue/lostRows';
import { returnedState, useRestoredScroll, WorkThroughBar } from '../queue/WorkThroughBar';
import bar from '../queue/WorkThroughBar.module.scss';
import styles from './LostText.module.scss';
import { useLeftQueue } from '../queue/useQueue';

const parsed = artifactSchema.safeParse(artifact);
export function LostTextPage() {
  useLeftQueue();
  const data = useDataStore((s) => s.data);
  const user = useAuthStore((s) => s.user);
  const { drafts, hydrated } = useDraftStore();
  const locked = useSaveState((s) => s.locked);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const pageRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const lastScroll = useRef(0);
  const lastSelected = useRef<string | null>(null);
  const item = params.get('item');
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const scrollTop = scrollPositions.current.get(location.key) ?? lastScroll.current;
    // Remember even unscrolled entries so Back restores their original position.
    scrollPositions.current.set(location.key, scrollTop);
    lastScroll.current = scrollTop;
    list.scrollTop = scrollTop;
    if (window.matchMedia?.('(max-width: 700px)').matches) {
      if (item) detailRef.current?.focus({ preventScroll: true });
      else if (lastSelected.current) {
        const row = Array.from(list.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.dataset.record === lastSelected.current,
        );
        (row ?? list).focus({ preventScroll: true });
      }
    }
    lastSelected.current = item;
  }, [location.key, item, data]);
  // Leave from a work-through queue brings the filters, selection, and scroll back.
  const returned = returnedState<LostRestore>(location.state);
  const [showDismissed, setShowDismissed] = useState(returned?.showDismissed ?? false);
  const [classFilter, setClassFilter] = useState(returned?.classFilter ?? '');
  const [query, setQuery] = useState(returned?.query ?? '');
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(returned?.selected ?? []),
  );
  const barAnchor = useRef<HTMLDivElement>(null);
  useRestoredScroll(barAnchor, returned?.scroll, Boolean(data), returned?.top, (top) => {
    // The list's own memory (the layout effect above) must not put it back to the top.
    scrollPositions.current.set(location.key, top);
    lastScroll.current = top;
  });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    // Phone notices sit above the workspace and must be visible after an action.
    if ((notice || error) && pageRef.current) pageRef.current.scrollTop = 0;
  }, [notice, error]);
  const storageKey = `clarity-lost-text:v1:${user?.id ?? 'anonymous'}`;
  const [stored, setStored] = useState<{ key: string; decisions: Record<string, string> }>({
    key: '',
    decisions: {},
  });
  const progress = useMemo(() => {
    if (stored.key === storageKey) return { decisions: stored.decisions, error: '' };
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.values(raw).some((v) => typeof v !== 'string')
      )
        throw new Error('Invalid stored decisions');
      return { decisions: raw as Record<string, string>, error: '' };
    } catch {
      return {
        decisions: {},
        error: 'Local dismissals could not be loaded. You can still review and recover text.',
      };
    }
  }, [stored, storageKey]);
  const loadingSkeleton = useSkeletonVisible(!data, 'Loading checker data…', true);
  if (user?.role === 'translator') return <Navigate to="/translations" replace />;
  if (!data || loadingSkeleton)
    return <LoadingSkeleton label="Loading checker data…" shape="rows" visible={loadingSkeleton} />;
  if (!parsed.success)
    return (
      <article>
        <h1>Lost-tooltip checker</h1>
        <p role="alert">Checker data is missing or invalid; regenerate lost-text.json.</p>
      </article>
    );
  const result = parsed.data;
  const rows = visibleRecords(
    result.records,
    data.bundle.tooltips,
    progress.decisions,
    classFilter !== '',
    classFilter === 'all' ? '' : classFilter,
    showDismissed,
  ).filter((r) => `${r.name} ${r.hash}`.toLowerCase().includes(query.trim().toLowerCase()));
  const queueItems = rows.map((record) => lostItem(record, data));
  const selected = result.records.find((r) => recordKey(r) === params.get('item'));
  const base = selected && data.bundle.tooltips[selected.hash];
  const current = base && (drafts[base.hash]?.next ?? base);
  const editable = canRecover(user);
  function dismiss() {
    if (!selected || !editable) return;
    try {
      const decisions = { ...progress.decisions, [recordKey(selected)]: fingerprint(selected) };
      localStorage.setItem(storageKey, JSON.stringify(decisions));
      setStored({ key: storageKey, decisions });
      setParams({});
      setNotice('Dismissed locally. Changed history will reopen this record.');
    } catch (cause) {
      setError(`Dismissal was not stored: ${errorMessage(cause)}`);
    }
  }
  function recover() {
    if (!selected || !base || !current || !user || !hydrated || locked) return;
    try {
      replaceDraft(base, recoveryDraft(current, selected, user));
      setNotice(
        'Recovered as a local draft. Review in the editor and save through the normal flow.',
      );
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <article ref={pageRef} className={styles.page}>
      <h1>Lost-tooltip checker</h1>
      <p>
        Blank saved tooltips with earlier text. Classification is evidence, not a judgment about why
        text was cleared.
      </p>
      {result.sourceCommit !== data.bundle.sourceCommit && (
        <p role="status">
          Checker data is from {result.sourceCommit.slice(0, 12)}; regenerate. Historical records
          remain viewable.
        </p>
      )}
      {(error || progress.error) && <p role="alert">{error || progress.error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className={styles.workspace} data-detail={Boolean(selected)}>
        <section
          ref={listRef}
          className={styles.list}
          aria-label="Possibly lost text"
          tabIndex={0}
          onScroll={(event) => {
            // Hiding the phone list can reset its DOM scroll offset; keep the visible position.
            if (!event.currentTarget.getClientRects().length) return;
            lastScroll.current = event.currentTarget.scrollTop;
            scrollPositions.current.set(location.key, lastScroll.current);
          }}
        >
          <label>
            Filter by name or hash
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label>
            Authorship class
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
              <option value="">Possibly authored — human and unclear</option>
              <option value="all">All classes — including copies and placeholders</option>
              <option value="human">
                Human — authorship evidence, differs from available manifest
              </option>
              <option value="unclear">
                Unclear — authorship or manifest evidence is inconclusive
              </option>
              <option value="manifest-copy">
                Manifest copy — matches an available manifest description
              </option>
              <option value="placeholder">Placeholder — only comments or import directives</option>
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
            />
            Show dismissed
          </label>
          <p role="status">
            {rows.length} of {result.records.length} records shown
          </p>
          <div ref={barAnchor}>
            <WorkThroughBar
              source="lost-text"
              selected={queueItems.filter((item) => picked.has(item.key))}
              shown={queueItems}
              restore={
                {
                  query,
                  classFilter,
                  showDismissed,
                  selected: [...picked],
                  item,
                } satisfies Omit<LostRestore, 'scroll' | 'top'>
              }
              onClear={() => setPicked(new Set())}
              anchor={barAnchor}
            />
          </div>
          {!rows.length && (
            <p>
              No blank tooltips with earlier authored text found.
              {(query || classFilter) && ' Try another filter.'}
            </p>
          )}
          {rows.map((r) => (
            <div className={styles.rowLine} key={recordKey(r)} data-row-key={recordKey(r)}>
              <label className={bar.select}>
                <input
                  type="checkbox"
                  checked={picked.has(recordKey(r))}
                  aria-label={`Select ${data.items[r.hash]?.name ?? r.name}, ${r.lang}`}
                  onChange={(event) => {
                    const key = recordKey(r);
                    const on = event.target.checked;
                    setPicked((old) => {
                      const next = new Set(old);
                      if (on) next.add(key);
                      else next.delete(key);
                      return next;
                    });
                  }}
                />
              </label>
              <button
                type="button"
                className={styles.row}
                data-record={recordKey(r)}
                aria-pressed={selected && recordKey(selected) === recordKey(r)}
                onClick={() => {
                  setParams({ item: recordKey(r) });
                  setNotice('');
                  setError('');
                }}
              >
                <strong>{data.items[r.hash]?.name ?? r.name}</strong>
                <span>
                  {r.lang} · {r.classification} · {r.hash}
                </span>
              </button>
            </div>
          ))}
        </section>
        {selected && (
          <section
            ref={detailRef}
            className={styles.detail}
            aria-label="Historical text detail"
            tabIndex={-1}
          >
            <button type="button" onClick={() => setParams({})}>
              Back to list
            </button>
            <h2>
              {data.items[selected.hash]?.name ?? selected.name} · {selected.lang}
            </h2>
            <p>
              {selected.classification}: {selected.reason}
            </p>
            <p>
              Cleared <When nowrap value={selected.clearingDate} /> by {selected.clearingAuthor}.{' '}
              <a
                href={`https://github.com/Database-Clarity/Live-Clarity-Database/commit/${selected.clearingCommit}`}
                target="_blank"
                rel="noreferrer"
              >
                Clearing commit {selected.clearingCommit.slice(0, 12)}
              </a>
            </p>
            <p>
              Last nonempty:{' '}
              <a
                href={`https://github.com/Database-Clarity/Live-Clarity-Database/commit/${selected.lastNonemptyCommit}`}
                target="_blank"
                rel="noreferrer"
              >
                {selected.lastNonemptyCommit.slice(0, 12)}
              </a>
            </p>
            <h3>Current saved text</h3>
            {base?.text[selected.lang]?.text ? (
              <ReadingTooltip
                text={base.text[selected.lang]!.text}
                lang={selected.lang}
                hash={selected.hash}
              />
            ) : (
              <p>(blank)</p>
            )}
            <h3>Historical text (last non-empty)</h3>
            <ReadingTooltip text={selected.text} lang={selected.lang} hash={selected.hash} />
            <details>
              <summary>Historical source text</summary>
              <pre>{selected.text}</pre>
            </details>
            {current?.text[selected.lang]?.text.trim() && (
              <p>A local draft or saved text already exists. Review it in the editor first.</p>
            )}
            <div className={styles.actions}>
              {editable && (
                <>
                  <p className={styles.consequences}>
                    Recover creates an unsaved local draft; nothing is saved automatically. Dismiss
                    hides this record for you in this browser only; it reopens if history changes.
                  </p>
                  <button
                    type="button"
                    disabled={
                      !hydrated ||
                      locked ||
                      !base ||
                      Boolean(current?.text[selected.lang]?.text.trim())
                    }
                    onClick={recover}
                  >
                    Recover as draft
                  </button>
                  <button type="button" disabled={locked} onClick={dismiss}>
                    Dismiss
                  </button>
                </>
              )}
              <Link to={`/t/${selected.hash}?lang=${selected.lang}`}>Open in editor</Link>
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
