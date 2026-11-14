/**
 * The Current / Upcoming switch's data side, loaded only when the build switch is ON and a
 * maintainer, editor, or translator has the editor open (UpcomingSwitch.tsx imports it lazily).
 *
 * - The batch index comes from GET /batches when the editor opens, then every minute while the tab
 *   is visible and on focus after 30 s, so a batch change arriving while open shows up.
 * - Members are read only for the batch whose Upcoming view is asked for, at the listing's head,
 *   and again only when that batch's revision moves (a commit elsewhere in editor-data does not
 *   refetch them).
 * - Upcoming = the activation result per member (core `activate`: current saved + the batch's
 *   changed fields, Q4 for translations), recomputed whenever current saved data changes.
 */
import type { Tooltip } from '@clarity/core';
import {
  activate,
  existsField,
  isOpenStatus,
  resolveActivation,
  type ActivationChoice,
  type BatchMember,
} from '@clarity/core/schedule';
import type { EditorData } from '../../stores/data';
import { listBatches, readBatchMembers } from '../../services/scheduled/api';
import { useDataStore } from '../../stores/data';
import {
  upcomingStore,
  type BatchLoad,
  type OpenBatch,
  type UpcomingState,
} from './UpcomingSwitch.store';

const refreshMs = 60_000;
const focusRefreshMs = 30_000;

/**
 * One member's future state. Clean: the activation result. Stale (current moved a field the batch
 * changes, or the existence rule): the batch's value wins each conflicted field only, which is what
 * an "Apply upcoming" resolution would publish; clean fields keep core's merge (an association both
 * sides added stays), and the conflicted fields are reported.
 */
export function upcomingOf(
  member: BatchMember,
  current: Tooltip | null,
): { tooltip: Tooltip; stale: string[] } {
  const input = { base: member.base, current, proposed: member.proposed };
  const result = activate(input);
  if (result.ok) return { tooltip: result.tooltip, stale: [] };
  const choices: Record<string, ActivationChoice> = {};
  // A deleted tooltip takes one existence choice; a tooltip created meanwhile merges against an
  // empty base, whose conflicts core names on the first pass (no existence choice applies there).
  for (const field of result.fields)
    if (field !== existsField || (member.base !== null && current === null))
      choices[field] = 'upcoming';
  try {
    for (let pass = 0; pass < 2; pass++) {
      const resolved = resolveActivation({ ...input, choices });
      if (resolved.ok) return { tooltip: resolved.tooltip ?? member.proposed, stale: result.fields };
      for (const field of resolved.missing) choices[field] = 'upcoming';
    }
  } catch {
    // An unexpected shape falls back to the proposal below.
  }
  return { tooltip: member.proposed, stale: result.fields };
}

/** Every member's future state over `data`'s current saved tooltips. */
export function upcomingState(members: readonly BatchMember[], data: EditorData): UpcomingState {
  const overlay: UpcomingState['overlay'] = {};
  const stale: Record<number, string[]> = {};
  for (const member of members) {
    const current = data.bundle.tooltips[member.hash] ?? null;
    const { tooltip, stale: fields } = upcomingOf(member, current);
    overlay[member.hash] = { base: current ?? tooltip, next: tooltip };
    if (fields.length) stale[member.hash] = fields;
  }
  return { overlay, stale };
}

let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribeData: (() => void) | undefined;
let listedAt = 0;
let listing: Promise<void> | undefined;
/** Open batches by id, from the latest listing. */
let open = new Map<string, OpenBatch>();
/** Members read per batch, with the revision they were read at (recomputed on data changes). */
const read = new Map<string, { revision: number; members: BatchMember[] }>();
/** The revision a member read is in flight for, per batch. */
const reading = new Map<string, number>();

function setLoad(id: string, load: BatchLoad | undefined) {
  const store = upcomingStore();
  const loads = { ...store.getState().loads };
  if (load) loads[id] = load;
  else delete loads[id];
  store.setState({ loads });
}

const sameBatch = (a: OpenBatch | undefined, b: OpenBatch) =>
  a !== undefined &&
  a.name === b.name &&
  a.status === b.status &&
  a.notBefore === b.notBefore &&
  a.revision === b.revision &&
  a.hashes.length === b.hashes.length &&
  a.hashes.every((hash, index) => hash === b.hashes[index]);

/** Fetch the index; keep every unchanged batch object so per-hash subscribers do not re-render. */
export function refreshBatches(): Promise<void> {
  listing ??= (async () => {
    try {
      const { head, index } = await listBatches();
      listedAt = Date.now();
      const store = upcomingStore();
      const before = store.getState();
      const next = new Map<string, OpenBatch>();
      for (const entry of index.batches) {
        if (!isOpenStatus(entry.status)) continue;
        const batch: OpenBatch = {
          id: entry.id,
          name: entry.name,
          status: entry.status as OpenBatch['status'],
          notBefore: entry.notBefore,
          revision: entry.revision,
          hashes: entry.hashes,
        };
        const previous = open.get(entry.id);
        next.set(entry.id, sameBatch(previous, batch) ? previous! : batch);
      }
      open = next;
      const memberOf: Record<number, OpenBatch> = {};
      for (const batch of next.values()) for (const hash of batch.hashes) memberOf[hash] = batch;
      const unchanged =
        Object.keys(memberOf).length === Object.keys(before.memberOf).length &&
        Object.entries(memberOf).every(([hash, batch]) => before.memberOf[Number(hash)] === batch);
      // Batches that closed drop their members; a moved revision re-reads them (the old future
      // state stays on screen until the new one is ready, so nothing flashes).
      const loads = { ...before.loads };
      const stale: string[] = [];
      for (const [id, load] of Object.entries(before.loads)) {
        const batch = next.get(id);
        if (!batch) {
          delete loads[id];
          read.delete(id);
        } else if (batch.revision !== load.revision) stale.push(id);
      }
      store.setState({ head, ...(unchanged ? {} : { memberOf }), loads });
      for (const id of stale) ensureBatch(id);
    } catch (error) {
      // Offline, signed out meanwhile, or the switch is off on the server: keep what is shown.
      console.warn('Scheduled batches: listing failed', error);
    } finally {
      listing = undefined;
    }
  })();
  return listing;
}

/** Read one batch's members (unless already read at its current revision) and compute its future state. */
export function ensureBatch(id: string) {
  const batch = open.get(id);
  const head = upcomingStore().getState().head;
  if (!batch || !head) return;
  const load = upcomingStore().getState().loads[id];
  if (load && load.revision === batch.revision && load.state !== 'failed') return;
  if (reading.get(id) === batch.revision) return;
  reading.set(id, batch.revision);
  if (!load || load.state !== 'ready') setLoad(id, { state: 'loading', revision: batch.revision });
  readBatchMembers(head, id, batch.hashes).then(
    (found) => {
      if (reading.get(id) === batch.revision) reading.delete(id);
      if (open.get(id)?.revision !== batch.revision) return;
      const members = found.filter((member): member is BatchMember => member !== null);
      read.set(id, { revision: batch.revision, members });
      const data = useDataStore.getState().data;
      if (data)
        setLoad(id, {
          state: 'ready',
          revision: batch.revision,
          upcoming: upcomingState(members, data),
        });
    },
    (error: unknown) => {
      if (reading.get(id) === batch.revision) reading.delete(id);
      if (open.get(id)?.revision !== batch.revision) return;
      setLoad(id, {
        state: 'failed',
        revision: batch.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

function recompute(data: EditorData) {
  const store = upcomingStore();
  const loads = { ...store.getState().loads };
  let changed = false;
  for (const [id, { revision, members }] of read) {
    if (loads[id]?.state !== 'ready' && loads[id]?.state !== 'loading') continue;
    loads[id] = { state: 'ready', revision, upcoming: upcomingState(members, data) };
    changed = true;
  }
  if (changed) store.setState({ loads });
}

function onVisible() {
  if (document.visibilityState === 'visible' && Date.now() - listedAt >= focusRefreshMs)
    void refreshBatches();
}

/** The editor is open: list now, keep listing while visible. Returns the matching stop. */
export function startUpcoming(): () => void {
  if (++users === 1) {
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshBatches();
    }, refreshMs);
    unsubscribeData = useDataStore.subscribe((state, previous) => {
      if (state.data && state.data !== previous.data) recompute(state.data);
    });
    void refreshBatches();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--users > 0) return;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    clearInterval(timer);
    unsubscribeData?.();
    unsubscribeData = undefined;
  };
}

/** Tests: forget every listing and read. */
export function resetUpcoming() {
  open = new Map();
  read.clear();
  reading.clear();
  listedAt = 0;
  listing = undefined;
  upcomingStore().setState({ head: null, memberOf: {}, loads: {}, source: 'current' });
}
