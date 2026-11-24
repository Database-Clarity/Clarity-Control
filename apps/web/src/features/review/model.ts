import {
  activeAliases,
  inactiveRemovalHash,
  isMovedInactive,
  isTextlessDescription,
  resolveAlias,
  type Tooltip,
} from '@clarity/core';
import { fingerprintDigests, prepareFingerprintWorker } from './fingerprints';
import type { GlobalPart } from './globalRows';
import type { Published } from './published';
import { heldSetBonus } from './setBonusHold';
import { useReviewQueue } from './queueStore';
import { useDataStore, type EditorData } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { allowBackgroundCode } from '../../workspacePreload';
import { useSidebarQueueStore, type SidebarPendingChange } from '../navigation/sidebarQueue';
export { canPushLive as canPush } from '../auth/permissions';

import { categoryDisplay } from '../../services/categoryLabels';
import { globalAggregates } from '../../services/globalsFlag';
import { savedAhead } from '../../stores/savedOverlay';

type InPlaceRow = NonNullable<EditorData['bundle']['globalsInPlace']>['rows'][string];

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
  inactiveChange?: 'remove' | 'restore';
  inactiveAliases?: number[];
  /** Review's row for one entry of a globals file (`globalRows.ts`); never a publish unit. */
  part?: GlobalPart;
  /** A changed global changes what this tooltip publishes (`bundle.globalsInPlace`). */
  globals?: {
    causes: InPlaceRow['causes'];
    /** The published text against what publishes now, globals filled in. */
    diff: InPlaceRow['diff'];
    /** Nobody edited the tooltip itself: its saved text is its published text. */
    unedited?: Published;
  };
  /** Review's row in this changed global's group; the tooltip stays the publish unit. */
  under?: InPlaceRow['causes'][number];
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
    globalsInPlace: EditorData['bundle']['globalsInPlace'];
    settled: ReadonlySet<number>;
  }
>();
const queues = new WeakMap<PendingTooltip[], SidebarPendingChange[]>();
/** The sidebar lists what a person changed; marker-only leftovers are one footer link. */
export function sidebarChanges(entries: PendingTooltip[]): SidebarPendingChange[] {
  let queue = queues.get(entries);
  if (!queue) {
    queue = entries
      .filter(({ markerOnly }) => !markerOnly)
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

const noHashes: ReadonlySet<number> = new Set();
const sameHashes = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
  a.size === b.size && [...a].every((hash) => b.has(hash));

export function preparedPending(
  data: EditorData,
  pushed = data.bundle.pushed,
  settled = noHashes,
): PendingTooltip[] | undefined {
  const snapshot = snapshots.get(data);
  return snapshot &&
    sameInputs(snapshot, data) &&
    sameMarkers(snapshot.markers, pushed) &&
    sameHashes(snapshot.settled, settled)
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
    snapshot.globalsInPlace === data.bundle.globalsInPlace
  );
}

/** `settled`: published in this session with the bundle's own globals (`acknowledgedGlobals`). */
export function pendingTooltips(
  data: EditorData,
  pushed = data.bundle.pushed,
  settled = noHashes,
): Promise<PendingTooltip[]> {
  const existing = snapshots.get(data);
  if (
    existing &&
    sameInputs(existing, data) &&
    sameMarkers(existing.markers, pushed) &&
    sameHashes(existing.settled, settled)
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
    globalsInPlace: data.bundle.globalsInPlace,
    settled,
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
  settled: ReadonlySet<number>,
): Promise<PendingTooltip[]> {
  const moves = data.bundle.inactiveMoves ?? {};
  const inPlace = data.bundle.globalsInPlace;
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
      // Globals that fill in tooltips never publish as files of their own.
      !(inPlace && globalAggregates.includes(tooltip.hash)),
  );
  const digests = await fingerprintDigests(tooltips, activeAliases(data.aliases, moves));
  const removals = new Map(
    await Promise.all(
      Object.keys(moves).map(
        async (key) => [Number(key), await inactiveRemovalHash(Number(key))] as const,
      ),
    ),
  );
  for (const [index, tooltip] of tooltips.entries())
    if (isMovedInactive(tooltip.hash, moves))
      digests[index] = { hash: removals.get(tooltip.hash)!, bare: removals.get(tooltip.hash)! };
  const categories = new Map(data.categories.map((entry) => [entry.id, entry]));
  const entries = tooltips.map((tooltip, index) => {
    const pushedMarker = pushed[tooltip.hash];
    const row = settled.has(tooltip.hash) ? undefined : inPlace?.rows[tooltip.hash];
    const authored = digests[index].hash !== pushedMarker;
    if (!authored && !row?.differs) return null;
    const item = data.items[tooltip.hash];
    const categoryId = item?.categoryId ?? tooltip.custom?.categoryId ?? 'other';
    const category = categories.get(categoryId);
    const global = categoryId === 'none' && globalAggregates.includes(tooltip.hash);
    const removing = isMovedInactive(tooltip.hash, moves);
    const restoring =
      !removing && removals.get(tooltip.hash) === pushedMarker && pushedMarker !== undefined;
    const inactiveAliases = Object.keys(moves)
      .map(Number)
      .filter((hash) => hash !== tooltip.hash && resolveAlias(hash, data.aliases) === tooltip.hash);
    const leftover =
      !removing &&
      !restoring &&
      !inactiveAliases.length &&
      pushedMarker !== undefined &&
      digests[index].bare === pushedMarker;
    const unedited = !authored || leftover;
    const ahead = !!row?.differs && row.causes.length > 0 && savedAhead(tooltip.hash);
    // A removal, a return, or a first publish is judged whole, whatever globals its text uses.
    const globals: PendingTooltip['globals'] =
      row?.differs &&
      !ahead &&
      !removing &&
      !restoring &&
      pushedMarker !== undefined &&
      (unedited || row.causes.length)
        ? {
            causes: row.causes,
            diff: row.diff,
            ...(unedited ? { unedited: { status: 'ready' as const, tooltip } } : {}),
          }
        : undefined;
    return {
      tooltip,
      name: item?.name ?? tooltip.custom?.name ?? `Tooltip ${tooltip.hash}`,
      category: global ? 'Globals' : (category ?? categoryDisplay(categoryId)).label,
      categoryId: global ? '~globals' : categoryId,
      categoryOrder: (category ?? categoryDisplay(categoryId)).order,
      markerOnly: leftover && !row?.differs,
      isNew: pushedMarker === undefined,
      ...(pushedMarker !== undefined ? { pushed: pushedMarker } : {}),
      ...(removing
        ? { inactiveChange: 'remove' as const }
        : restoring
          ? { inactiveChange: 'restore' as const }
          : {}),
      ...(inactiveAliases.length ? { inactiveAliases } : {}),
      ...(!removing && !item && !tooltip.custom
        ? { unpublishable: 'No generator entry for this tooltip, so it cannot be pushed.' }
        : {}),
      ...(!removing ? heldSetBonus(categoryId) : {}),
      ...(globals ? { globals } : {}),
      ...(ahead && !removing && !restoring
        ? {
            unpublishable:
              'It was saved after this list was built. Refresh to review it with its globals.',
          }
        : {}),
      ...(!removing && row?.refusal !== undefined ? { unpublishable: row.refusal } : {}),
    };
  });
  return entries
    .filter((entry): entry is PendingTooltip => entry !== null)
    .sort(
      (a, b) =>
        a.categoryOrder - b.categoryOrder ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name) ||
        a.tooltip.hash - b.tooltip.hash,
    );
}

export function toggleSelection(selected: ReadonlySet<number>, hash: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(hash)) next.add(hash);
  return next;
}

export function selectedPending(
  selected: ReadonlySet<number>,
  pending: PendingTooltip[],
): number[] {
  return pending
    .filter(
      ({ tooltip, unpublishable, inactiveChange }) =>
        (!isTextlessDescription(tooltip) || inactiveChange === 'remove') &&
        !unpublishable &&
        selected.has(tooltip.hash),
    )
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

/** What "Include all N" and group ticks pick: never the leftovers, which a data task clears. */
export function publishableHashes(page: PendingTooltip[]): number[] {
  const hashes = page
    .filter(
      ({ tooltip, unpublishable, markerOnly, inactiveChange, under, globals }) =>
        (!isTextlessDescription(tooltip) || inactiveChange === 'remove') &&
        !unpublishable &&
        !markerOnly &&
        // A global's group never picks someone's own edit in bulk; its category does.
        !(under && !globals?.unedited),
    )
    .map(({ tooltip }) => tooltip.hash);
  return [...new Set(hashes)];
}

export function stepIndex(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index + delta));
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
    if (data)
      void pendingTooltips(data)
        .then((entries) => {
          if (useDataStore.getState().data === data) publishSidebar(entries);
        })
        .catch(() => {});
  };
  useDataStore.subscribe((state, previous) => {
    if (state.data !== previous.data) warm();
  });
  useAuthStore.subscribe((state, previous) => {
    if (state.user?.role !== previous.user?.role) warm();
  });
  warm();
}
