/**
 * The Batches subview's data (scheduled changes, P3a). Loaded only with the build switch ON for
 * maintainers, editors, and translators (ReviewPage imports this chunk lazily).
 *
 * - The index comes from GET /batches when the subview opens, every 60 s while the tab is visible,
 *   on focus after 30 s, and right after every write, so a batch change arriving while open shows.
 * - Per batch, batch.json, its members, and (published batches) its activation conflict files are
 *   read from raw at the listing's head, and read again only when the batch's revision moves:
 *   every batch write, the claim, RECORD, and resolve bump it, so an unrelated editor-data commit
 *   never refetches anything. Open batches, the ten newest published ones, and the open detail are
 *   read (three batches at a time); the list shows counts for those.
 */
import { create } from 'zustand';
import type { ActivationConflict, Batch, BatchMember } from '@clarity/core/schedule';
import {
  listBatches,
  readActivationConflicts,
  readBatch,
  readBatchMembers,
} from '../../../services/scheduled/api';
import { errorMessage } from '../../../services/http';
import { isOpenStatus } from '@clarity/core/schedule';
import type { IndexEntry } from './model';

export interface BatchDetail {
  /** The commit this was read at. */
  head: string;
  batch: Batch;
  members: BatchMember[];
  /** Activation conflict files of this batch's members (published batches only). */
  conflicts: ActivationConflict[];
}

export type DetailLoad =
  | { state: 'loading'; revision: number; detail?: BatchDetail }
  | { state: 'ready'; revision: number; detail: BatchDetail }
  | { state: 'failed'; revision: number; error: string; detail?: BatchDetail };

export interface BatchesState {
  head: string | null;
  entries: IndexEntry[] | null;
  listError: string | null;
  listing: boolean;
  loads: Readonly<Record<string, DetailLoad>>;
  /** The batch the detail shows (URL `batch`), always read. */
  focus: string | null;
}

export const useBatches = create<BatchesState>(() => ({
  head: null,
  entries: null,
  listError: null,
  listing: false,
  loads: {},
  focus: null,
}));

const refreshMs = 60_000;
const focusRefreshMs = 30_000;
const parallel = 3;
const recentPublished = 10;
let listedAt = 0;
let listing: Promise<void> | undefined;
let queue: IndexEntry[] = [];
let running = 0;
let generation = 0;

function setLoad(id: string, load: DetailLoad) {
  useBatches.setState((state) => ({ loads: { ...state.loads, [id]: load } }));
}

async function readDetail(head: string, entry: IndexEntry): Promise<BatchDetail> {
  const [batch, members] = await Promise.all([
    readBatch(head, entry.id),
    readBatchMembers(head, entry.id, entry.hashes),
  ]);
  if (!batch) throw new Error(`Batch ${entry.name} is missing at ${head.slice(0, 8)}`);
  const present = members.filter((member): member is BatchMember => member !== null);
  const conflicts =
    batch.status === 'published'
      ? (await readActivationConflicts(head, entry.hashes)).filter(
          (conflict): conflict is ActivationConflict =>
            conflict !== null && conflict.batchId === entry.id,
        )
      : [];
  return { head, batch, members: present, conflicts };
}

function pump() {
  while (running < parallel && queue.length) {
    const entry = queue.shift()!;
    const head = useBatches.getState().head;
    if (!head) return;
    const mine = generation;
    running++;
    const previous = useBatches.getState().loads[entry.id];
    setLoad(entry.id, {
      state: 'loading',
      revision: entry.revision,
      detail: previous && 'detail' in previous ? previous.detail : undefined,
    });
    void readDetail(head, entry)
      .then(
        (detail) => {
          if (mine === generation)
            setLoad(entry.id, { state: 'ready', revision: entry.revision, detail });
        },
        (error: unknown) => {
          if (mine !== generation) return;
          const before = useBatches.getState().loads[entry.id];
          setLoad(entry.id, {
            state: 'failed',
            revision: entry.revision,
            error: errorMessage(error),
            detail: before && 'detail' in before ? before.detail : undefined,
          });
        },
      )
      .finally(() => {
        if (mine !== generation) return;
        running--;
        pump();
      });
  }
}

/** Queues reads for the batches the list counts and the open detail, at their current revision. */
function want() {
  const { entries, loads, focus } = useBatches.getState();
  if (!entries) return;
  const published = entries
    .filter((entry) => entry.status === 'published')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, recentPublished);
  const wanted = new Set([
    ...entries.filter((entry) => isOpenStatus(entry.status)),
    ...published,
    ...entries.filter((entry) => entry.id === focus),
  ]);
  const queued = new Set(queue.map((entry) => entry.id));
  for (const entry of wanted) {
    const load = loads[entry.id];
    // Read once per revision; a failed read waits for its Retry (or a newer revision), never loops.
    if (queued.has(entry.id) || load?.revision === entry.revision) continue;
    queue.push(entry);
  }
  // The open detail first.
  queue.sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  pump();
}

/** Fetch the index (one request at a time) and queue member reads for moved revisions. */
export function refreshBatches(): Promise<void> {
  listing ??= (async () => {
    useBatches.setState({ listing: true });
    try {
      const { head, index } = await listBatches();
      listedAt = Date.now();
      useBatches.setState({ head, entries: index.batches, listError: null });
      want();
    } catch (error) {
      useBatches.setState({ listError: errorMessage(error) });
    } finally {
      useBatches.setState({ listing: false });
      listing = undefined;
    }
  })();
  return listing;
}

/** The detail's batch: read it (first) whenever its revision is not loaded yet. */
export function focusBatch(id: string | null) {
  if (useBatches.getState().focus === id) return;
  useBatches.setState({ focus: id });
  want();
}

/** Retry a failed batch read. */
export function retryBatch(id: string) {
  const { entries, loads } = useBatches.getState();
  const entry = entries?.find((candidate) => candidate.id === id);
  if (!entry) return void refreshBatches();
  if (loads[id]?.state !== 'failed') return;
  queue = queue.filter((queued) => queued.id !== id);
  queue.unshift(entry);
  pump();
}

let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function onFocus() {
  if (Date.now() - listedAt >= focusRefreshMs) void refreshBatches();
}

/** Mounted by the subview (list or detail): starts and stops the refresh timers. */
export function startBatches(): () => void {
  users++;
  if (users === 1) {
    void refreshBatches();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshBatches();
    }, refreshMs);
    window.addEventListener('focus', onFocus);
  }
  return () => {
    users--;
    if (users === 0) {
      clearInterval(timer);
      timer = undefined;
      window.removeEventListener('focus', onFocus);
    }
  };
}

/** Tests: forget everything. */
export function resetBatches() {
  generation++;
  queue = [];
  running = 0;
  listedAt = 0;
  listing = undefined;
  useBatches.setState({
    head: null,
    entries: null,
    listError: null,
    listing: false,
    loads: {},
    focus: null,
  });
}
