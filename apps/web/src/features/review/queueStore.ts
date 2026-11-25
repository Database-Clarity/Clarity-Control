import { create } from 'zustand';
import { publishableHashInput, stableStringify } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { subscribeSavedRows } from '../../stores/savedOverlay';
import { canPublishTranslations, canPushLive, publishLanguages } from '../auth/permissions';
import { rowKey, type RowKey } from './globalRows';
import type { PendingTooltip } from './model';
import { markerGroup, translationGroup, type Leftovers } from './queueModel';

interface SavedRow {
  key: RowKey;
  version: string;
}

interface Decision extends SavedRow {
  was: boolean;
}

interface ReviewMessage extends SavedRow {
  text: string;
  included?: boolean;
}

/**
 * Review state shared by the left-column queue and the page: the pending entries, what is
 * selected for the publish, and which groups are collapsed (not the URL; remembered per device).
 */
interface ReviewQueueState {
  /** Every pending saved change, leftovers included; null until the first comparison. */
  entries: PendingTooltip[] | null;
  selected: ReadonlySet<number>;
  versions: ReadonlyMap<RowKey, string>;
  account: string | null;
  decisions: readonly Decision[];
  message: ReviewMessage | undefined;
  collapsed: ReadonlySet<string>;
  /** Migration leftovers are hidden until the list's "Show". */
  leftovers: Leftovers;
  /** Rows where only translations wait, likewise (editors and maintainers). */
  translations: Leftovers;
  /** The list's scroll position, kept across leaving and returning to the route. */
  scrollTop: number;
  setEntries(entries: PendingTooltip[]): void;
  toggle(hash: number): void;
  decide(entry: PendingTooltip): void;
  undo(inFlight: ReadonlySet<number>): RowKey | undefined;
  showMessage(entry: PendingTooltip, text: string): void;
  /** Adds every hash when any is missing, otherwise removes them all (a group's checkbox). */
  toggleAll(hashes: readonly number[]): void;
  /** Adds every hash ("Include all N"). */
  includeAll(hashes: readonly number[]): void;
  clearSelection(): void;
  removePublished(entries: readonly PendingTooltip[]): void;
  toggleGroup(id: string): void;
  showLeftovers(): void;
  showTranslations(): void;
}

const empty: ReadonlySet<never> = new Set();
const noVersions: ReadonlyMap<RowKey, string> = new Map();
const picksKey = 'clarity-review-inclusions:v1';

function readVersions(account: string | null): ReadonlyMap<RowKey, string> {
  try {
    const stored = sessionStorage.getItem(picksKey);
    if (!stored) return noVersions;
    const value = JSON.parse(stored);
    if (account !== null && value?.account === account && Array.isArray(value.versions)) {
      return new Map(
        value.versions.filter(
          (pair: unknown) =>
            Array.isArray(pair) &&
            (typeof pair[0] === 'number' || typeof pair[0] === 'string') &&
            typeof pair[1] === 'string',
        ),
      );
    }
    sessionStorage.removeItem(picksKey);
  } catch {
    // A tab can still keep its selection in memory.
  }
  return noVersions;
}

function writeVersions(account: string | null, versions: ReadonlyMap<RowKey, string>) {
  try {
    if (account !== null && versions.size)
      sessionStorage.setItem(picksKey, JSON.stringify({ account, versions: [...versions] }));
    else sessionStorage.removeItem(picksKey);
  } catch {
    // A tab can still keep its selection in memory.
  }
}

const indexes = new WeakMap<
  PendingTooltip[],
  { byKey: Map<RowKey, PendingTooltip>; byHash: Map<number, PendingTooltip> }
>();
function indexOf(entries: PendingTooltip[]) {
  let index = indexes.get(entries);
  if (!index) {
    index = { byKey: new Map(), byHash: new Map() };
    for (const entry of entries) {
      index.byKey.set(rowKey(entry), entry);
      index.byHash.set(entry.tooltip.hash, entry);
    }
    indexes.set(entries, index);
  }
  return index;
}

function reconcile(state: ReviewQueueState, entries: PendingTooltip[]) {
  if (!state.versions.size && !state.decisions.length && !state.message) return { entries };
  const { byKey: index } = indexOf(entries);
  return {
    entries,
    ...retainRows(state, (row) => index.get(row.key)?.savedVersion === row.version, entries),
  };
}

function retainRows(
  state: ReviewQueueState,
  valid: (row: SavedRow) => boolean,
  entries = state.entries,
) {
  const versions = new Map([...state.versions].filter(([key, version]) => valid({ key, version })));
  if (versions.size !== state.versions.size) writeVersions(state.account, versions);
  const selected = new Set<number>();
  if (entries && versions.size) {
    const { byKey } = indexOf(entries);
    for (const key of versions.keys()) {
      const entry = byKey.get(key);
      if (entry) selected.add(entry.tooltip.hash);
    }
  }
  return {
    versions,
    selected: selected.size ? selected : empty,
    decisions: state.decisions.filter(valid),
    message: state.message && valid(state.message) ? state.message : undefined,
  };
}

function updatePicks(
  state: ReviewQueueState,
  entries: readonly PendingTooltip[],
  include: boolean,
) {
  const versions = new Map(state.versions);
  const selected = new Set(state.selected);
  for (const entry of entries) {
    const key = rowKey(entry);
    if (include && entry.savedVersion !== undefined && !entry.unpublishable) {
      versions.set(key, entry.savedVersion);
      selected.add(entry.tooltip.hash);
    } else if (!include) {
      versions.delete(key);
      selected.delete(entry.tooltip.hash);
    }
  }
  writeVersions(state.account, versions);
  return { versions, selected };
}

// Queue checkboxes use the numeric publish keys, including the tab-local keys for globals.
const byHash = (entries: PendingTooltip[], hashes: readonly number[]) => {
  const { byHash: index } = indexOf(entries);
  return hashes.flatMap((hash) => index.get(hash) ?? []);
};

/** The collapsed category groups, remembered per device like the other view state. */
const collapsedKey = 'clarity-review-collapsed:v1';
function readCollapsed(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]');
    if (Array.isArray(value))
      return new Set(
        value.filter(
          (id): id is string =>
            typeof id === 'string' && id !== markerGroup && id !== translationGroup,
        ),
      );
  } catch {
    // Unreadable or unavailable storage: every group starts open.
  }
  return empty;
}
function writeCollapsed(collapsed: ReadonlySet<string>) {
  try {
    if (collapsed.size) localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
    else localStorage.removeItem(collapsedKey);
  } catch {
    // Storage full or blocked: the choice still holds for this session.
  }
}

export const useReviewQueue = create<ReviewQueueState>((set, get) => ({
  entries: null,
  selected: empty,
  versions: noVersions,
  account: null,
  decisions: [],
  message: undefined,
  collapsed: readCollapsed(),
  leftovers: 'hidden',
  translations: 'hidden',
  scrollTop: 0,
  setEntries: (entries) =>
    set((state) => (state.entries === entries ? state : reconcile(state, entries))),
  toggle: (hash) => get().toggleAll([hash]),
  decide: (entry) =>
    set((state) => {
      const key = rowKey(entry);
      const version = entry.savedVersion;
      if (
        state.account === null ||
        version === undefined ||
        entry.unpublishable ||
        !state.entries ||
        indexOf(state.entries).byKey.get(key)?.savedVersion !== version
      )
        return state;
      const was = state.selected.has(entry.tooltip.hash);
      return {
        ...updatePicks(state, [entry], !was),
        decisions: [...state.decisions.slice(-49), { key, version, was }],
        message: {
          key,
          version,
          text: `${entry.name}: ${was ? 'removed from' : 'included in'} the publish.`,
          included: !was,
        },
      };
    }),
  undo: (inFlight) => {
    const state = get();
    const last = state.decisions.at(-1);
    if (state.account === null || !last || !state.entries) return undefined;
    const entry = indexOf(state.entries).byKey.get(last.key);
    if (
      !entry ||
      entry.savedVersion !== last.version ||
      entry.unpublishable ||
      inFlight.has(entry.tooltip.hash)
    )
      return undefined;
    set({
      ...updatePicks(state, [entry], last.was),
      decisions: state.decisions.slice(0, -1),
      message: { key: last.key, version: last.version, text: `${entry.name}: undone.` },
    });
    return last.key;
  },
  showMessage: (entry, text) => {
    if (entry.savedVersion !== undefined)
      set({ message: { key: rowKey(entry), version: entry.savedVersion, text } });
  },
  toggleAll: (hashes) =>
    set((state) =>
      state.account === null || !state.entries || !hashes.length
        ? state
        : updatePicks(
            state,
            byHash(state.entries, hashes),
            !hashes.every((hash) => state.selected.has(hash)),
          ),
    ),
  includeAll: (hashes) =>
    set((state) =>
      state.account === null || !state.entries || hashes.every((hash) => state.selected.has(hash))
        ? state
        : updatePicks(state, byHash(state.entries, hashes), true),
    ),
  clearSelection: () => {
    writeVersions(get().account, noVersions);
    set({ versions: noVersions, selected: empty, decisions: [], message: undefined });
  },
  removePublished: (entries) => {
    const sent = new Map(entries.map((entry) => [rowKey(entry), entry.savedVersion]));
    set((state) => retainRows(state, ({ key, version }) => sent.get(key) !== version));
  },
  toggleGroup: (id) =>
    set((state) => {
      if (id === markerGroup)
        return { leftovers: state.leftovers === 'open' ? 'collapsed' : 'open' };
      if (id === translationGroup)
        return { translations: state.translations === 'open' ? 'collapsed' : 'open' };
      const next = new Set(state.collapsed);
      if (!next.delete(id)) next.add(id);
      writeCollapsed(next);
      return { collapsed: next };
    }),
  showLeftovers: () =>
    set((state) => (state.leftovers === 'hidden' ? { leftovers: 'collapsed' } : state)),
  showTranslations: () =>
    set((state) => (state.translations === 'hidden' ? { translations: 'collapsed' } : state)),
}));

// The first settled identity may restore this tab's ticks. A later transition always clears
// them, including when the Review route is unmounted. A same-account auth refresh is harmless.
let accountKnown = false;
let listedLanguages = '';
function syncAccount({ user, loading }: ReturnType<typeof useAuthStore.getState>) {
  if (!accountKnown && loading && !user) return;
  // A translator's ticks are another list's: a role change never carries them over.
  const account =
    user && canPushLive(user)
      ? String(user.id)
      : user && canPublishTranslations(user)
        ? `${user.id}/translations`
        : null;
  // Another kind of list, or other languages: nothing of the old one stays, on screen or ticked.
  const assigned = publishLanguages(user);
  const languages = assigned.join();
  const listed = ({ key }: { key: RowKey }) =>
    !assigned.length || assigned.some((lang) => String(key).endsWith(`:${lang}`));
  if (languages !== listedLanguages) {
    listedLanguages = languages;
    const state = useReviewQueue.getState();
    useReviewQueue.setState({ ...retainRows(state, listed), entries: null });
  }
  const state = useReviewQueue.getState();
  if (accountKnown && state.account === account) return;
  const versions = accountKnown
    ? noVersions
    : new Map([...readVersions(account)].filter(([key]) => listed({ key })));
  if (accountKnown && state.versions.size) writeVersions(account, noVersions);
  accountKnown = true;
  const next = { ...state, account, versions, selected: empty, decisions: [], message: undefined };
  useReviewQueue.setState(state.entries ? { ...next, ...reconcile(next, state.entries) } : next);
}
useAuthStore.subscribe(syncAccount);
syncAccount(useAuthStore.getState());

// Retire changed picks when the save is acknowledged. A reload can otherwise restore an old
// pick while the bundle still has the old text and the tab's saved overlay is gone.
subscribeSavedRows((saved) => {
  const state = useReviewQueue.getState();
  const tracked = (key: RowKey) =>
    state.versions.has(key) ||
    state.decisions.some((row) => row.key === key) ||
    state.message?.key === key;
  const bundle = useDataStore.getState().data?.bundle;
  // A translator's row stands for its own language of the saved entry.
  const lanes = (state.entries ?? []).filter(({ lane }) => lane && tracked(lane.key));
  if (lanes.length) {
    const outdated = new Set<RowKey>(
      lanes.flatMap(({ lane }) => {
        const next =
          'global' in saved
            ? saved.global.id === lane!.id && { entry: saved.global.definitions[lane!.lang] }
            : saved.tooltips.some(({ hash }) => hash === lane!.hash) && {
                entry: saved.tooltips.find(({ hash }) => hash === lane!.hash)!.text[lane!.lang],
              };
        const changed =
          next && stableStringify(next.entry ?? null) !== stableStringify(lane!.saved ?? null);
        return changed || (!('global' in saved) && saved.deleted.includes(lane!.hash!))
          ? [lane!.key]
          : [];
      }),
    );
    if (outdated.size) useReviewQueue.setState(retainRows(state, ({ key }) => !outdated.has(key)));
    return;
  }
  if ('global' in saved) {
    const { id } = saved.global;
    if (!tracked(id)) return;
    const previous = bundle?.globals?.entries.find((row) => row.id === id);
    if (!previous || stableStringify(previous) !== stableStringify(saved.global))
      useReviewQueue.setState(retainRows(state, ({ key }) => key !== id));
    return;
  }
  const changed = new Set<RowKey>(saved.deleted.filter(tracked));
  for (const tooltip of saved.tooltips) {
    const { hash } = tooltip;
    if (!tracked(hash)) continue;
    const previous =
      (state.entries && indexOf(state.entries).byKey.get(hash)?.tooltip) ?? bundle?.tooltips[hash];
    // Compare existing fingerprint inputs for the saved rows only. The pending comparison
    // still checks aliases and movement once it installs the next snapshot.
    if (!previous || publishableHashInput(previous) !== publishableHashInput(tooltip))
      changed.add(hash);
  }
  if (changed.size) useReviewQueue.setState(retainRows(state, ({ key }) => !changed.has(key)));
});
