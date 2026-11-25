import {
  activeAliases,
  inactiveRemovalHash,
  isMovedInactive,
  isTextlessDescription,
  resolveAlias,
  type Tooltip,
} from '@clarity/core';
import { fingerprintDigests, prepareFingerprintWorker } from './fingerprints';
import { isFolded, type GlobalPart } from './globalRows';
import type { Lane } from './lanes';
import { globalEntries } from './globalsPending';
import { heldSetBonus } from './setBonusHold';
import { useReviewQueue } from './queueStore';
import { useDataStore, type EditorData } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { allowBackgroundCode } from '../../workspacePreload';
import { useSidebarQueueStore, type SidebarPendingChange } from '../navigation/sidebarQueue';
import { acknowledgedGlobals, acknowledgedMarkers, useReviewSession } from './session';
import { canPushLive } from '../auth/permissions';
export { canPushLive as canPush } from '../auth/permissions';

import { categoryDisplay } from '../../services/categoryLabels';
import { globalAggregates } from '../../services/globalsFlag';
import { savedGlobalsAhead } from '../../stores/savedOverlay';

export interface PendingTooltip {
  tooltip: Tooltip;
  name: string;
  category: string;
  categoryId: string;
  categoryOrder: number;
  /** Set when the Worker would reject it (422): no generator entry and not a custom tooltip. */
  unpublishable?: string;
  /**
   * The saved content equals the last push; only the incoming-alias marker differs. These are
   * leftovers of the alias migration, not changes a person made. Classified locally, in the same
   * worker pass as the pending check; no stored data changes.
   */
  markerOnly: boolean;
  /** Never pushed: no recorded marker. */
  isNew: boolean;
  /** The pushed marker this row is compared with (absent when never pushed). */
  pushed?: string;
  /** Saved version from the existing pending comparison; absent if the saved text is unavailable. */
  savedVersion?: string;
  inactiveChange?: 'remove' | 'restore';
  inactiveAliases?: number[];
  /** The pending definition of a global row. */
  part?: GlobalPart;
  /** Only translations wait here: folded for editors, published by the translators. */
  translationOnly?: true;
  /** Translations wait here, on a row the bundle does not vouch for: see `folds.ts`. */
  mayFold?: true;
  /** One language of a tooltip or shared text: a translator's row. */
  lane?: Lane;
}

const snapshots = new WeakMap<
  EditorData,
  {
    markers: Record<string, string>;
    pending: Promise<PendingTooltip[]>;
    entries?: PendingTooltip[];
    aliases: EditorData['aliases'];
    tooltips: EditorData['bundle']['tooltips'];
    items: EditorData['items'];
    categories: EditorData['categories'];
    inactiveMoves: EditorData['bundle']['inactiveMoves'];
    globalsPending: EditorData['bundle']['globalsPending'];
    settled: ReadonlySet<string>;
    ahead: ReadonlySet<string>;
    folds: boolean;
  }
>();
const queues = new WeakMap<PendingTooltip[], SidebarPendingChange[]>();
/** The sidebar lists what a person changed; folded rows are its footer's lines. */
export function sidebarChanges(entries: PendingTooltip[]): SidebarPendingChange[] {
  let queue = queues.get(entries);
  if (!queue) {
    queue = entries
      .filter((entry) => !isFolded(entry))
      .map(({ tooltip, name, category }) => ({ hash: tooltip.hash, name, category }));
    queues.set(entries, queue);
  }
  return queue;
}
/** Hand the left-column queue every pending entry (it groups and collapses marker-only itself). */
export function publishSidebar(
  entries: PendingTooltip[],
  sidebar = useSidebarQueueStore.getState(),
) {
  useReviewQueue.getState().setEntries(entries);
  sidebar.setPendingChanges(sidebarChanges(entries));
}
function sameMarkers(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

const noGlobals: ReadonlySet<string> = new Set();
const sameGlobals = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** Editors and maintainers fold the rows that translators publish. */
const folds = () => canPushLive(useAuthStore.getState().user);

/** A global's save changes no loaded data, only what its listed row is compared with. */
const globalsAhead = ({ bundle }: EditorData) =>
  bundle.globalsPending ? savedGlobalsAhead(bundle) : noGlobals;

export function preparedPending(
  data: EditorData,
  pushed = data.bundle.pushed,
  settled = noGlobals,
): PendingTooltip[] | undefined {
  const snapshot = snapshots.get(data);
  return snapshot &&
    sameInputs(snapshot, data) &&
    sameMarkers(snapshot.markers, pushed) &&
    sameGlobals(snapshot.settled, settled)
    ? snapshot.entries
    : undefined;
}

function sameInputs(snapshot: NonNullable<ReturnType<typeof snapshots.get>>, data: EditorData) {
  return (
    snapshot.aliases === data.aliases &&
    snapshot.tooltips === data.bundle.tooltips &&
    snapshot.items === data.items &&
    snapshot.categories === data.categories &&
    snapshot.inactiveMoves === data.bundle.inactiveMoves &&
    snapshot.globalsPending === data.bundle.globalsPending &&
    sameGlobals(snapshot.ahead, globalsAhead(data)) &&
    snapshot.folds === folds()
  );
}

/** `settled`: globals this session published that the loaded bundle still lists. */
export function pendingTooltips(
  data: EditorData,
  pushed = data.bundle.pushed,
  settled = noGlobals,
): Promise<PendingTooltip[]> {
  const existing = snapshots.get(data);
  if (
    existing &&
    sameInputs(existing, data) &&
    sameMarkers(existing.markers, pushed) &&
    sameGlobals(existing.settled, settled)
  )
    return existing.pending;
  const snapshot = {
    markers: { ...pushed },
    pending: computePending(data, pushed, settled),
    entries: undefined as PendingTooltip[] | undefined,
    aliases: data.aliases,
    tooltips: data.bundle.tooltips,
    items: data.items,
    categories: data.categories,
    inactiveMoves: data.bundle.inactiveMoves,
    globalsPending: data.bundle.globalsPending,
    settled,
    ahead: globalsAhead(data),
    folds: folds(),
  };
  snapshots.set(data, snapshot);
  void snapshot.pending.then(
    (entries) => {
      snapshot.entries = entries;
    },
    () => {
      if (snapshots.get(data) === snapshot) snapshots.delete(data);
    },
  );
  return snapshot.pending;
}

async function computePending(
  data: EditorData,
  pushed: Record<string, string>,
  settled: ReadonlySet<string>,
): Promise<PendingTooltip[]> {
  const moves = data.bundle.inactiveMoves ?? {};
  const sources = { ...data.bundle.tooltips };
  for (const key of Object.keys(moves)) {
    const hash = resolveAlias(Number(key), data.aliases);
    if (!sources[hash] && (isMovedInactive(hash, moves) || pushed[hash]))
      sources[hash] = { hash, text: {}, associated: [] };
  }
  const tooltips = Object.values(sources).filter(
    (tooltip) =>
      (!isTextlessDescription(tooltip) || isMovedInactive(tooltip.hash, moves)) &&
      resolveAlias(tooltip.hash, data.aliases) === tooltip.hash &&
      // Globals filled into tooltips have no files of their own to publish.
      !globalAggregates.includes(tooltip.hash),
  );
  const digests = await fingerprintDigests(tooltips, activeAliases(data.aliases, moves));
  const removals = new Map(
    await Promise.all(
      Object.keys(moves).map(
        async (key) => [Number(key), await inactiveRemovalHash(Number(key))] as const,
      ),
    ),
  );
  const categories = new Map(data.categories.map((entry) => [entry.id, entry]));
  const only = folds() ? data.bundle.translationPublish?.only : undefined;
  const onlyTooltips = new Set(only?.tooltips);
  const translated = only ? readyLanes(data) : undefined;
  const built = (data.tooltipSnapshot ?? data.bundle).tooltips;
  const entries = tooltips.map((tooltip, index) => {
    const pushedMarker = pushed[tooltip.hash];
    const removing = isMovedInactive(tooltip.hash, moves);
    const saved = digests[index];
    if ((removing ? removals.get(tooltip.hash) : saved.hash) === pushedMarker) return null;
    const item = data.items[tooltip.hash];
    const categoryId = item?.categoryId ?? tooltip.custom?.categoryId ?? 'other';
    const category = categories.get(categoryId);
    const restoring =
      !removing && removals.get(tooltip.hash) === pushedMarker && pushedMarker !== undefined;
    const inactiveAliases = Object.keys(moves)
      .map(Number)
      .filter((hash) => hash !== tooltip.hash && resolveAlias(hash, data.aliases) === tooltip.hash);
    // The bundle's word holds for exactly the saved and live text it was built from.
    const listed = onlyTooltips.has(tooltip.hash);
    const translationOnly =
      (listed || translated?.has(tooltip.hash)) &&
      built[tooltip.hash] === tooltip &&
      pushedMarker !== undefined &&
      pushedMarker === data.bundle.pushed[tooltip.hash] &&
      !removing &&
      !restoring &&
      !inactiveAliases.length;
    return {
      tooltip,
      name: item?.name ?? tooltip.custom?.name ?? `Tooltip ${tooltip.hash}`,
      category: (category ?? categoryDisplay(categoryId)).label,
      categoryId,
      categoryOrder: (category ?? categoryDisplay(categoryId)).order,
      markerOnly:
        !removing &&
        !restoring &&
        !inactiveAliases.length &&
        pushedMarker !== undefined &&
        saved.bare === pushedMarker,
      isNew: pushedMarker === undefined,
      savedVersion: removing ? `remove:${saved.hash}` : saved.hash,
      ...(pushedMarker !== undefined ? { pushed: pushedMarker } : {}),
      ...(removing
        ? { inactiveChange: 'remove' as const }
        : restoring
          ? { inactiveChange: 'restore' as const }
          : {}),
      ...(inactiveAliases.length ? { inactiveAliases } : {}),
      ...(translationOnly
        ? listed
          ? { translationOnly: true as const }
          : { mayFold: true as const }
        : {}),
      ...(!removing && !item && !tooltip.custom
        ? { unpublishable: 'No generator entry for this tooltip, so it cannot be pushed.' }
        : {}),
      ...(!removing ? heldSetBonus(categoryId) : {}),
    };
  });
  const globals = globalEntries(data, {
    settled,
    ahead: globalsAhead(data),
    only: new Set(only?.globals),
  });
  return [...entries, ...globals]
    .filter((entry): entry is PendingTooltip => entry !== null)
    .sort(
      (a, b) =>
        a.categoryOrder - b.categoryOrder ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name) ||
        a.tooltip.hash - b.tooltip.hash,
    );
}

/** Tooltips with translations ready to publish alone, and none that waits for its English. */
function readyLanes({ bundle }: EditorData): ReadonlySet<number> {
  const ready = new Set<number>();
  const blocked = new Set<number>();
  for (const row of Object.values(bundle.translationPublish?.lanes ?? {}).flat())
    if (row?.kind === 'tooltip') (row.status === 'ready' ? ready : blocked).add(row.hash);
  for (const hash of blocked) ready.delete(hash);
  return ready;
}

export function toggleSelection(selected: ReadonlySet<number>, hash: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(hash)) next.add(hash);
  return next;
}

/** The server would take this row; a removed global or translation has no text either. */
const canPublish = ({ tooltip, unpublishable, inactiveChange, part, lane }: PendingTooltip) =>
  (part?.pending || lane || !isTextlessDescription(tooltip) || inactiveChange === 'remove') &&
  !unpublishable;

export function selectedPending(
  selected: ReadonlySet<number>,
  pending: PendingTooltip[],
): number[] {
  return pending
    .filter((entry) => canPublish(entry) && selected.has(entry.tooltip.hash))
    .map(({ tooltip }) => tooltip.hash);
}

/**
 * What Publish sends (and the confirm dialog lists): exactly the ticked rows that are still
 * pending and publishable, minus rows inside a publish that is still running; nothing else.
 */
export function publishSelection(
  selected: ReadonlySet<number>,
  pending: PendingTooltip[],
  inFlight: ReadonlySet<number>,
): PendingTooltip[] {
  if (!selected.size) return [];
  const chosen = new Set(selectedPending(selected, pending).filter((hash) => !inFlight.has(hash)));
  return pending.filter(({ tooltip }) => chosen.has(tooltip.hash));
}

/** What "Include all N" and group ticks pick: never the folded rows. */
export function publishableHashes(page: PendingTooltip[]): number[] {
  const hashes = page
    .filter((entry) => canPublish(entry) && !isFolded(entry))
    .map(({ tooltip }) => tooltip.hash);
  return [...new Set(hashes)];
}

export function stepIndex(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index + delta));
}

/** Prepare the same acknowledged snapshot as Review before the route opens. */
export async function prepareReviewQueue(data: EditorData) {
  const markers = acknowledgedMarkers(data);
  const settled = acknowledgedGlobals(data);
  const { acknowledgments, globals } = useReviewSession.getState();
  const { user } = useAuthStore.getState();
  const entries = await pendingTooltips(data, markers, settled);
  const current = useReviewSession.getState();
  if (
    useAuthStore.getState().user === user &&
    useDataStore.getState().data === data &&
    current.acknowledgments === acknowledgments &&
    current.globals === globals
  )
    publishSidebar(entries);
}

// Prepare every saved snapshot equally, independent of the next workspace destination.
if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
  const warm = () => {
    const role = useAuthStore.getState().user?.role;
    if (!allowBackgroundCode() || (role !== 'editor' && role !== 'maintainer')) return;
    // Initialize code while the bundle/catalogue are still loading, without sending data.
    try {
      prepareFingerprintWorker();
    } catch {
      return;
    }
    const data = useDataStore.getState().data;
    if (data) void prepareReviewQueue(data).catch(() => {});
  };
  useDataStore.subscribe((state, previous) => {
    if (state.data !== previous.data) warm();
  });
  useAuthStore.subscribe((state, previous) => {
    if (state.user?.role !== previous.user?.role) warm();
  });
  useReviewSession.subscribe((state, previous) => {
    if (state.acknowledgments !== previous.acknowledgments || state.globals !== previous.globals)
      warm();
  });
  warm();
}
