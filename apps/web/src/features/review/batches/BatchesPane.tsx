/**
 * Review changes → Batches (scheduled changes, spec "Editor UX"; P3a). The left column lists the
 * batches; the main column shows the open one (`?view=batches&batch=<id>`). Loaded only with the
 * build switch ON, for maintainers, editors, and translators (ReviewPage, ReviewSidebar).
 */
import {
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { isOpenStatus } from '@clarity/core/schedule';
import { useAuthStore } from '../../../stores/auth';
import { useDataStore, type EditorData } from '../../../stores/data';
import { zonedNotBefore } from '../../../services/format/date';
import { createBatch } from '../../../services/scheduled/api';
import { canPushLive } from '../../auth/permissions';
import { FinderSheetCloseContext } from '../../navigation/FinderSheetContext';
import { phoneQuery, useMedia } from '../../../ui/useMedia';
import {
  isOverdue,
  memberView,
  openConflicts,
  orderBatches,
  statusChip,
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

/** Only the split view defaults to the first listed batch. */
function useOpenBatch(entries: IndexEntry[] | null, asked: string | null, phone: boolean) {
  const ordered = useMemo(() => (entries ? orderBatches(entries) : []), [entries]);
  const open = ordered.find((entry) => entry.id === asked) ?? (phone ? undefined : ordered[0]);
  return { ordered, open };
}

function batchParams(params: URLSearchParams, id: string) {
  const next = new URLSearchParams(params);
  next.set('view', 'batches');
  next.set('batch', id);
  return next;
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

function BatchRow({
  entry,
  selected,
  search,
  replace,
  fromList,
}: {
  entry: IndexEntry;
  selected: boolean;
  search: string;
  replace: boolean;
  fromList: boolean;
}) {
  const load = useBatches((state) => state.loads[entry.id]);
  const data = useDataStore((state) => state.data);
  const counts = useMemo(() => rowCounts(entry, load, data), [entry, load, data]);
  const chip = statusChip(entry);
  const facts = [
    plural(entry.hashes.length, 'tooltip'),
    counts?.stale ? `${counts.stale} stale` : '',
    counts?.conflicts ? plural(counts.conflicts, 'conflict') : '',
    counts?.coverage?.needed
      ? `translations ${counts.coverage.ready}/${counts.coverage.needed}`
      : '',
  ].filter(Boolean);
  return (
    <BatchRowView
      id={entry.id}
      name={entry.name}
      selected={selected}
      search={search}
      replace={replace}
      fromList={fromList}
      chip={chip}
      when={entry.notBefore ? zonedNotBefore(entry.notBefore) : 'No time set'}
      facts={facts}
    />
  );
}

export function BatchRowView({
  id,
  name,
  selected,
  search,
  chip,
  when,
  facts,
  replace = true,
  fromList = false,
}: {
  id: string;
  name: string;
  selected: boolean;
  search: string;
  chip: { tone: string; label: string };
  when: string;
  facts: string[];
  replace?: boolean;
  fromList?: boolean;
}) {
  const closeSheet = useContext(FinderSheetCloseContext);
  return (
    <li>
      <Link
        to={{ search }}
        replace={replace}
        state={fromList ? { batchFromList: true } : undefined}
        className={styles.row}
        aria-current={selected ? 'true' : undefined}
        data-batch-row={id}
        onClick={(event) => {
          if (
            !event.defaultPrevented &&
            event.button === 0 &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
          )
            closeSheet?.();
        }}
      >
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowMeta}>
          <span className={styles.chip} data-tone={chip.tone}>
            {chip.label}
          </span>
          <span className={styles.rowWhen}>{when}</span>
        </span>
        <span className={styles.rowFacts}>
          {facts.map((fact, index) => (
            <Fragment key={fact}>
              {index ? ' ' : ''}
              <span className={styles.segment} data-stale={fact.endsWith('stale') || undefined}>
                {index ? '· ' : ''}
                {fact}
              </span>
            </Fragment>
          ))}
        </span>
      </Link>
    </li>
  );
}

/** "New batch…": a name, then Create (maintainers and editors). */
function NewBatch({ onCreated }: { onCreated(id: string): void }) {
  const { key } = useLocation();
  const owner = useRef(0);
  useLayoutEffect(
    () => () => {
      owner.current++;
    },
    [key],
  );
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
    const submittedFrom = owner.current;
    setPending(true);
    setError(null);
    try {
      const { batch } = await createBatch(trimmed);
      await refreshBatches();
      setOpen(false);
      setName('');
      // The write can finish after the user opens a different batch or leaves the list.
      if (owner.current === submittedFrom) onCreated(batch.id);
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
export function BatchesList({ phone = false }: { phone?: boolean }) {
  useEffect(startBatches, []);
  const entries = useBatches((state) => state.entries);
  const listError = useBatches((state) => state.listError);
  const user = useAuthStore((state) => state.user);
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  const closeSheet = useContext(FinderSheetCloseContext);
  const asked = params.get('batch') || null;
  const { ordered, open } = useOpenBatch(entries, asked, phone);
  const push = phone && !asked;
  const fromList = push || (state as { batchFromList?: boolean } | null)?.batchFromList === true;
  const firstClosed = ordered.findIndex((entry) => !isOpenStatus(entry.status));
  return (
    <div className={styles.list}>
      {canPushLive(user) && (
        <NewBatch
          onCreated={(id) => {
            setParams(batchParams(params, id), {
              replace: !push,
              state: fromList ? { batchFromList: true } : undefined,
            });
            closeSheet?.();
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
              <BatchRow
                entry={entry}
                selected={entry.id === open?.id}
                search={`?${batchParams(params, entry.id)}`}
                replace={!push}
                fromList={fromList}
              />
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

/** The main column: a single list or detail on phones, the detail of the split view elsewhere. */
export function BatchesMain({ phone = false }: { phone?: boolean }) {
  useEffect(startBatches, []);
  const entries = useBatches((state) => state.entries);
  const listError = useBatches((state) => state.listError);
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  const navigate = useNavigate();
  const asked = params.get('batch') || null;
  const { open } = useOpenBatch(entries, asked, phone);
  const previousBatch = useRef(asked);
  const list = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previous = previousBatch.current;
    previousBatch.current = asked;
    if (!phone || previous === asked) return;
    if (asked) back.current?.focus();
    else if (list.current) {
      const row = Array.from(
        list.current.querySelectorAll<HTMLAnchorElement>('[data-batch-row]'),
      ).find((link) => link.dataset.batchRow === previous);
      (row ?? list.current).focus();
    }
  }, [asked, phone]);
  useEffect(() => focusBatch(open?.id ?? null), [open?.id]);
  useEffect(() => () => focusBatch(null), []);
  if (phone && !asked)
    return (
      <nav ref={list} className={styles.phoneList} aria-label="Batch list" tabIndex={-1}>
        <BatchesList phone />
      </nav>
    );

  const detail = !entries ? (
    listError ? (
      <p role="alert" className={styles.note}>
        {listError}{' '}
        <button type="button" className={styles.textButton} onClick={() => void refreshBatches()}>
          Retry
        </button>
      </p>
    ) : (
      <p className={styles.note}>Loading batches…</p>
    )
  ) : !open ? (
    <p className={styles.note}>
      {phone && asked
        ? 'That batch is no longer listed.'
        : 'No batches yet. A batch holds tooltip changes that publish together, not before a time you choose.'}
    </p>
  ) : (
    <>
      {asked && asked !== open.id && (
        <p className={styles.note} role="note">
          That batch is not listed any more; showing {open.name}.
        </p>
      )}
      <BatchDetail key={open.id} entry={open} />
    </>
  );
  return (
    <>
      {phone && (
        <div className={styles.backStrip}>
          <button
            ref={back}
            type="button"
            onClick={() => {
              if ((state as { batchFromList?: boolean } | null)?.batchFromList) {
                void navigate(-1);
              } else {
                const next = new URLSearchParams(params);
                next.delete('batch');
                setParams(next, { replace: true });
              }
            }}
          >
            ‹ Back to batches
          </button>
        </div>
      )}
      {detail}
    </>
  );
}

/** Review header: Saved | Batches. Saved keeps its filters and open change in the URL. */
export function SubviewSwitch() {
  const [params, setParams] = useSearchParams();
  const phone = useMedia(phoneQuery);
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
            if (view === value) return;
            const next = subviewParams(params, value);
            if (phone && value === 'batches') next.delete('batch');
            setParams(next);
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
  // Only schedules that are ready count as scheduled; preparing and failed ones are named apart.
  const scheduled = open.filter(
    (entry) => entry.status === 'scheduled' || entry.status === 'publishing',
  ).length;
  const preparing = open.filter((entry) => entry.status === 'preparing').length;
  const attention = open.filter((entry) => entry.status === 'needs_attention').length;
  // Each open batch is counted once: a preparing batch past its time shows as "(n overdue)".
  const latePreparing = open.filter(
    (entry) => entry.status === 'preparing' && isOverdue(entry),
  ).length;
  const overdue = open.filter((entry) => entry.status !== 'preparing' && isOverdue(entry)).length;
  const segment = (text: ReactNode, flagged = false) => (
    <>
      {' '}
      <span className={styles.segment} data-overdue={flagged || undefined}>
        · {text}
      </span>
    </>
  );
  return (
    <>
      <p className={`${reviewStyles.counts} ${styles.headerCounts}`}>
        <span className={styles.segment}>
          <b>{count.format(open.length)}</b> open {open.length === 1 ? 'batch' : 'batches'}
        </span>
        {segment(`${count.format(scheduled)} scheduled`)}
        {preparing > 0 &&
          segment(
            `${count.format(preparing)} preparing${latePreparing ? ` (${count.format(latePreparing)} overdue)` : ''}`,
            latePreparing > 0,
          )}
        {overdue > 0 && segment(`${count.format(overdue)} overdue`, true)}
        {attention > 0 &&
          segment(`${count.format(attention)} need${attention === 1 ? 's' : ''} attention`, true)}
      </p>
      <span className={reviewStyles.summaryEnd}>
        <button type="button" disabled={listing} onClick={() => void refreshBatches()}>
          Refresh
        </button>
      </span>
    </>
  );
}
