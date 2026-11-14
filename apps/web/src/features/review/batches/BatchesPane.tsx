/**
 * Review changes → Batches (scheduled changes, spec "Editor UX"; P3a). The left column lists the
 * batches; the main column shows the open one (`?view=batches&batch=<id>`). Loaded only with the
 * build switch ON, for maintainers, editors, and translators (ReviewPage, ReviewSidebar).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { isOpenStatus } from '@clarity/core/schedule';
import { useAuthStore } from '../../../stores/auth';
import { useDataStore, type EditorData } from '../../../stores/data';
import { zonedNotBefore } from '../../../services/format/date';
import { createBatch } from '../../../services/scheduled/api';
import { canPushLive } from '../../auth/permissions';
import {
  isOverdue,
  memberView,
  openConflicts,
  orderBatches,
  statusLabel,
  statusTone,
  translationCoverage,
  type IndexEntry,
} from './model';
import { focusBatch, refreshBatches, startBatches, useBatches, type DetailLoad } from './store';
import { BatchDetail } from './BatchDetail';
import { Refusal } from './Refusal';
import { useNames } from './names';
import { subviewParams } from '../subview';
import reviewStyles from '../Review.module.scss';
import styles from './Batches.module.scss';

const count = new Intl.NumberFormat('en');
const plural = (n: number, word: string) => `${count.format(n)} ${word}${n === 1 ? '' : 's'}`;

/** The open batch id: the URL's, else the first listed. */
function useOpenBatch(entries: IndexEntry[] | null) {
  const [params] = useSearchParams();
  const asked = params.get('batch');
  const ordered = useMemo(() => (entries ? orderBatches(entries) : []), [entries]);
  const open = ordered.find((entry) => entry.id === asked) ?? ordered[0];
  return { ordered, open, asked };
}

/** List counts for one batch, once its members are read: members, stale, conflicts, coverage. */
function rowCounts(entry: IndexEntry, load: DetailLoad | undefined, data: EditorData | null) {
  const detail = load && 'detail' in load ? load.detail : undefined;
  if (!detail || !data) return null;
  let stale = 0;
  if (isOpenStatus(entry.status))
    for (const member of detail.members)
      if (
        memberView(
          member,
          data.bundle.tooltips[member.hash] ?? null,
          member.hash in data.bundle.pushed,
        ).stale.length
      )
        stale++;
  return {
    stale,
    conflicts: openConflicts(detail.conflicts).length,
    coverage: isOpenStatus(entry.status) ? translationCoverage(detail.members) : null,
  };
}

function BatchRow({ entry, selected }: { entry: IndexEntry; selected: boolean }) {
  const [params] = useSearchParams();
  const load = useBatches((state) => state.loads[entry.id]);
  const data = useDataStore((state) => state.data);
  const counts = useMemo(() => rowCounts(entry, load, data), [entry, load, data]);
  const overdue = isOverdue(entry);
  const next = new URLSearchParams(params);
  next.set('view', 'batches');
  next.set('batch', entry.id);
  const facts = [
    plural(entry.hashes.length, 'tooltip'),
    counts?.stale ? `${counts.stale} stale` : '',
    counts?.conflicts ? plural(counts.conflicts, 'conflict') : '',
    counts?.coverage?.needed
      ? `translations ${counts.coverage.ready}/${counts.coverage.needed}`
      : '',
  ].filter(Boolean);
  return (
    <li>
      <Link
        to={{ search: `?${next}` }}
        replace
        className={styles.row}
        aria-current={selected ? 'true' : undefined}
        data-batch-row={entry.id}
      >
        <span className={styles.rowHead}>
          <span className={styles.rowName} title={entry.name}>
            {entry.name}
          </span>
          <span className={styles.chip} data-tone={overdue ? 'warn' : statusTone[entry.status]}>
            {overdue ? 'Overdue' : statusLabel[entry.status]}
          </span>
        </span>
        <span className={styles.rowWhen}>
          {entry.notBefore ? zonedNotBefore(entry.notBefore) : 'No time set'}
        </span>
        <span className={styles.rowFacts}>
          {facts.map((fact, index) => (
            <span
              key={fact}
              className={styles.segment}
              data-stale={fact.endsWith('stale') || undefined}
            >
              {index ? '· ' : ''}
              {fact}
            </span>
          ))}
        </span>
      </Link>
    </li>
  );
}

/** "New batch…": a name, then Create (maintainers and editors). */
function NewBatch({ onCreated }: { onCreated(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const names = useNames();
  if (!open)
    return (
      <button type="button" className={styles.newBatch} onClick={() => setOpen(true)}>
        New batch…
      </button>
    );
  async function create() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const { batch } = await createBatch(trimmed);
      await refreshBatches();
      setOpen(false);
      setName('');
      onCreated(batch.id);
    } catch (reason) {
      setError(reason);
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className={styles.newForm}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <input
        aria-label="New batch name"
        placeholder="Batch name"
        maxLength={80}
        value={name}
        disabled={pending}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" disabled={pending || !name.trim()}>
        {pending ? 'Creating...' : 'Create'}
      </button>
      <button type="button" disabled={pending} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error !== null && <Refusal error={error} names={names} />}
    </form>
  );
}

/** The left column (and the phone's list sheet) in the Batches subview. */
export function BatchesList() {
  useEffect(startBatches, []);
  const entries = useBatches((state) => state.entries);
  const listError = useBatches((state) => state.listError);
  const user = useAuthStore((state) => state.user);
  const [params, setParams] = useSearchParams();
  const { ordered, open } = useOpenBatch(entries);
  const firstClosed = ordered.findIndex((entry) => !isOpenStatus(entry.status));
  return (
    <div className={styles.list}>
      {canPushLive(user) && (
        <NewBatch
          onCreated={(id) => {
            const next = new URLSearchParams(params);
            next.set('view', 'batches');
            next.set('batch', id);
            setParams(next, { replace: true });
          }}
        />
      )}
      {listError && (
        <p role="alert" className={styles.note}>
          {listError}{' '}
          <button type="button" className={styles.textButton} onClick={() => void refreshBatches()}>
            Retry
          </button>
        </p>
      )}
      {entries === null && !listError ? (
        <p className={styles.note}>Loading batches…</p>
      ) : entries && !entries.length ? (
        <p className={styles.note}>No batches yet.</p>
      ) : (
        <ul className={styles.rows} aria-label="Batches">
          {ordered.map((entry, index) => (
            <BatchGroup key={entry.id} first={index === firstClosed}>
              <BatchRow entry={entry} selected={entry.id === open?.id} />
            </BatchGroup>
          ))}
        </ul>
      )}
    </div>
  );
}

function BatchGroup({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <>
      {first && (
        <li className={styles.groupHead} aria-hidden="true">
          Published and cancelled
        </li>
      )}
      {children}
    </>
  );
}

/** The main column in the Batches subview: the open batch's detail. */
export function BatchesMain() {
  useEffect(startBatches, []);
  const entries = useBatches((state) => state.entries);
  const listError = useBatches((state) => state.listError);
  const { open, asked } = useOpenBatch(entries);
  useEffect(() => focusBatch(open?.id ?? null), [open?.id]);
  useEffect(() => () => focusBatch(null), []);
  if (!entries)
    return listError ? (
      <p role="alert" className={styles.note}>
        {listError}{' '}
        <button type="button" className={styles.textButton} onClick={() => void refreshBatches()}>
          Retry
        </button>
      </p>
    ) : (
      <p className={styles.note}>Loading batches…</p>
    );
  if (!open)
    return (
      <p className={styles.note}>
        No batches yet. A batch holds tooltip changes that publish together, not before a time you
        choose.
      </p>
    );
  return (
    <>
      {asked && asked !== open.id && (
        <p className={styles.note} role="note">
          That batch is not listed any more; showing {open.name}.
        </p>
      )}
      <BatchDetail key={open.id} entry={open} />
    </>
  );
}

/** Review header: Saved | Batches. Saved keeps its filters and open change in the URL. */
export function SubviewSwitch() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'batches' ? 'batches' : 'saved';
  return (
    <span className={styles.subviews} role="group" aria-label="Review view">
      {(['saved', 'batches'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          data-perf-navigation="true"
          onClick={() => {
            if (view !== value) setParams(subviewParams(params, value));
          }}
        >
          {value === 'saved' ? 'Saved' : 'Batches'}
        </button>
      ))}
    </span>
  );
}

/** Batches header line: open, scheduled, and overdue counts, and Refresh. */
export function BatchesHeader() {
  const entries = useBatches((state) => state.entries);
  const listing = useBatches((state) => state.listing);
  const open = entries?.filter((entry) => isOpenStatus(entry.status)) ?? [];
  const scheduled = open.filter((entry) => entry.status !== 'draft').length;
  const overdue = open.filter((entry) => isOverdue(entry)).length;
  return (
    <>
      <p className={reviewStyles.counts}>
        <span className={reviewStyles.segment}>
          <b>{count.format(open.length)}</b> open {open.length === 1 ? 'batch' : 'batches'}
        </span>{' '}
        <span className={reviewStyles.segment}>· {count.format(scheduled)} scheduled</span>
        {overdue > 0 && (
          <>
            {' '}
            <span className={reviewStyles.segment} data-overdue>
              · {count.format(overdue)} overdue
            </span>
          </>
        )}
      </p>
      <span className={reviewStyles.summaryEnd}>
        <button type="button" disabled={listing} onClick={() => void refreshBatches()}>
          Refresh
        </button>
      </span>
    </>
  );
}
