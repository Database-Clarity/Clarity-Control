import { isTextlessDescription, resolveAlias, type Tooltip } from '@clarity/core';
import { fingerprintDigests, prepareFingerprintWorker } from './fingerprints';
import { heldSetBonus } from './setBonusHold';
import { useReviewQueue } from './queueStore';
import { useDataStore, type EditorData } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { allowBackgroundCode } from '../../workspacePreload';
import { useSidebarQueueStore, type SidebarPendingChange } from '../navigation/sidebarQueue';
export { canPushLive as canPush } from '../auth/permissions';

import { categoryDisplay } from '../../services/categoryLabels';

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

export function preparedPending(
  data: EditorData,
  pushed = data.bundle.pushed,
): PendingTooltip[] | undefined {
  const snapshot = snapshots.get(data);
  return snapshot && sameInputs(snapshot, data) && sameMarkers(snapshot.markers, pushed)
    ? snapshot.entries
    : undefined;
}

function sameInputs(snapshot: NonNullable<ReturnType<typeof snapshots.get>>, data: EditorData) {
  return (
    snapshot.aliases === data.aliases &&
    snapshot.tooltips === data.bundle.tooltips &&
    snapshot.items === data.items &&
    snapshot.categories === data.categories
  );
}

export function pendingTooltips(
  data: EditorData,
  pushed = data.bundle.pushed,
): Promise<PendingTooltip[]> {
  const existing = snapshots.get(data);
  if (existing && sameInputs(existing, data) && sameMarkers(existing.markers, pushed))
    return existing.pending;
  const snapshot = {
    markers: { ...pushed },
    pending: computePending(data, pushed),
    entries: undefined as PendingTooltip[] | undefined,
    aliases: data.aliases,
    tooltips: data.bundle.tooltips,
    items: data.items,
    categories: data.categories,
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
  pushed = data.bundle.pushed,
): Promise<PendingTooltip[]> {
  const tooltips = Object.values(data.bundle.tooltips).filter(
    (tooltip) =>
      !isTextlessDescription(tooltip) && resolveAlias(tooltip.hash, data.aliases) === tooltip.hash,
  );
  const digests = await fingerprintDigests(tooltips, data.aliases);
  const categories = new Map(data.categories.map((entry) => [entry.id, entry]));
  const entries = tooltips.map((tooltip, index) => {
    const pushedMarker = pushed[tooltip.hash];
    if (digests[index].hash === pushedMarker) return null;
    const item = data.items[tooltip.hash];
    const categoryId = item?.categoryId ?? tooltip.custom?.categoryId ?? 'other';
    const category = categories.get(categoryId);
    return {
      tooltip,
      name: item?.name ?? tooltip.custom?.name ?? `Tooltip ${tooltip.hash}`,
      category: (category ?? categoryDisplay(categoryId)).label,
      categoryId,
      categoryOrder: (category ?? categoryDisplay(categoryId)).order,
      markerOnly: pushedMarker !== undefined && digests[index].bare === pushedMarker,
      isNew: pushedMarker === undefined,
      ...(!item && !tooltip.custom
        ? { unpublishable: 'No generator entry for this tooltip, so it cannot be pushed.' }
        : {}),
      ...heldSetBonus(categoryId),
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
      ({ tooltip, unpublishable }) =>
        !isTextlessDescription(tooltip) && !unpublishable && selected.has(tooltip.hash),
    )
    .map(({ tooltip }) => tooltip.hash);
}

/** What "Select page" picks: never the marker-only leftovers, which a data task clears. */
export function publishableHashes(page: PendingTooltip[]): number[] {
  return page
    .filter(
      ({ tooltip, unpublishable, markerOnly }) =>
        !isTextlessDescription(tooltip) && !unpublishable && !markerOnly,
    )
    .map(({ tooltip }) => tooltip.hash);
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
