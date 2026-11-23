import { create } from 'zustand';
import { resolveAlias, type Aliases } from '@clarity/core';
import type { MarkAction, Marks } from '@clarity/core/marks';
import { apiUrl, type User } from '../../services/api';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useMarksStore } from '../marks/store';

/**
 * Maintainers' decisions about entries, shared with everyone through config/marks.json:
 * - no-match: no Compendium row right now; ends by itself at a confident match
 * - not-needed: the entry needs no Compendium row
 */
export type SharedKind = 'no-match' | 'not-needed';
export interface SharedDecision {
  kind: SharedKind;
  /** Unset until the save is acknowledged. */
  by?: number;
  at?: string;
}
export type SharedDecisions = ReadonlyMap<number, SharedDecision>;
type Saved = Record<string, Required<SharedDecision>>;
const savedIn = (marks: Marks) => (marks as Marks & { compendium?: Saved }).compendium;
/** Hashes per request; larger sets are split. */
const batchSize = 200;

/** An entry grouped after its decision was made shows it on its main entry. */
function mainEntry(hash: number, aliases: Aliases | undefined) {
  try {
    return aliases ? resolveAlias(hash, aliases) : hash;
  } catch {
    return hash;
  }
}

type Pending = ReadonlyMap<number, SharedKind | null>;
const none: Pending = new Map();
interface SavesState {
  /** The account that made the pending decisions: no other one sees or writes them. */
  owner?: User['id'];
  /** Not yet acknowledged, by main entry: the decision, or null for a cleared one. */
  pending: Pending;
  error: string | null;
  set(hashes: readonly number[], kind: SharedKind | null): void;
  retry(): void;
  /** Gives up on decisions that could not be saved. */
  discard(): void;
}
const account = () => useAuthStore.getState().user?.id;

export const useSharedSaves = create<SavesState>((set, get) => ({
  pending: none,
  error: null,
  set(hashes, kind) {
    const owner = account();
    const pending = new Map(get().owner === owner ? get().pending : none);
    for (const hash of hashes) pending.set(hash, kind);
    set({ owner, pending, error: null });
    window.addEventListener('beforeunload', keepPage);
    void drain();
  },
  retry() {
    set({ error: null });
    void drain();
  },
  discard() {
    set({ pending: none, error: null });
  },
}));

/** This account's decisions the server has not acknowledged, and why not. */
export function useUnsaved() {
  const user = useAuthStore((state) => state.user?.id);
  const mine = useSharedSaves((state) => state.owner === user);
  const pending = useSharedSaves((state) => state.pending);
  const error = useSharedSaves((state) => state.error);
  return mine ? { pending, error } : { pending: none, error: null };
}

/** Leaving the page would lose decisions the server has not acknowledged: the browser asks first. */
function keepPage(event: BeforeUnloadEvent) {
  if (useSharedSaves.getState().pending.size) event.preventDefault();
  else window.removeEventListener('beforeunload', keepPage);
}

/**
 * The next request: the first pending decision's kind, for every entry that has it. Read again for
 * each attempt, so a decision undone meanwhile is never written.
 */
function nextBatch(pending: Pending) {
  const kind: SharedKind | null = [...pending.values()][0];
  const entries = [...pending].flatMap(([hash, value]) => (value === kind ? [hash] : []));
  if (kind) {
    const hashes = entries.slice(0, batchSize);
    return { entries: hashes, change: { action: 'compendium-set', kind, hashes } };
  }
  // A clear removes every stored decision that shows on the entry, as stored right now.
  const aliases = useDataStore.getState().data?.aliases;
  const stored = new Map<number, number[]>();
  for (const key of Object.keys(savedIn(useMarksStore.getState().marks) ?? {}).map(Number)) {
    const main = mainEntry(key, aliases);
    stored.set(main, [...(stored.get(main) ?? []), key]);
  }
  const cleared: number[] = [];
  const hashes: number[] = [];
  for (const entry of entries) {
    const keys = stored.get(entry) ?? [];
    if (hashes.length && hashes.length + keys.length > batchSize) break;
    cleared.push(entry);
    hashes.push(...keys);
  }
  return { entries: cleared, change: { action: 'compendium-clear', hashes } };
}

let draining = false;
/** One request at a time; decisions made meanwhile join a later one. */
async function drain() {
  if (draining) return;
  draining = true;
  const { owner } = useSharedSaves.getState();
  const current = () => useSharedSaves.getState().owner === owner && account() === owner;
  try {
    for (let attempt = 1; current() && useSharedSaves.getState().pending.size;) {
      try {
        await marksReady();
        if (!current() || !useSharedSaves.getState().pending.size) return;
        const { pending } = useSharedSaves.getState();
        const { entries, change } = nextBatch(pending);
        if (change.hashes.length)
          await useMarksStore.getState().save(change as unknown as MarkAction);
        if (!current()) return;
        const rest = new Map(useSharedSaves.getState().pending);
        for (const hash of entries) if (rest.get(hash) === pending.get(hash)) rest.delete(hash);
        useSharedSaves.setState({ pending: rest });
        attempt = 1;
      } catch (error) {
        // The actions are idempotent: after a lost race the marks are read and written again.
        if (attempt++ < 3) await new Promise((resolve) => setTimeout(resolve, 400));
        else {
          if (current()) useSharedSaves.setState({ error: errorMessage(error) });
          return;
        }
      }
    }
  } finally {
    draining = false;
    // Another account decided something while this one's request was on its way.
    if (useSharedSaves.getState().owner !== owner) void drain();
  }
}

/** The marks as they are now, once no other save (the entry's marks popover) is on its way. */
async function marksReady() {
  if (useMarksStore.getState().saving)
    await new Promise<void>((resolve) => {
      const stop = useMarksStore.subscribe(({ saving }) => {
        if (saving) return;
        stop();
        resolve();
      });
    });
  if (useMarksStore.getState().writable) return;
  await useMarksStore.getState().reload();
  const { writable, error } = useMarksStore.getState();
  if (!writable) throw new Error(error ?? 'Marks unavailable; read-only.');
}

let merged: { saved?: Saved; pending?: Pending; aliases?: Aliases; value: SharedDecisions } = {
  value: new Map(),
};
/** The decisions as shown, by main entry: the saved ones with the unacknowledged ones applied. */
function mergeShared(
  saved: Saved | undefined,
  pending: Pending,
  aliases: Aliases | undefined,
): SharedDecisions {
  if (merged.saved === saved && merged.pending === pending && merged.aliases === aliases)
    return merged.value;
  const value = new Map<number, SharedDecision>();
  for (const [key, decision] of Object.entries(saved ?? {})) {
    const hash = Number(key);
    const main = mainEntry(hash, aliases);
    // The main entry's own decision outranks a grouped one's.
    if (main === hash || !saved![main]) value.set(main, decision);
  }
  for (const [hash, kind] of pending)
    if (kind) value.set(hash, { kind });
    else value.delete(hash);
  merged = { saved, pending, aliases, value };
  return value;
}

export function useSharedDecisions(): SharedDecisions {
  const saved = useMarksStore((state) => savedIn(state.marks));
  const { pending } = useUnsaved();
  const aliases = useDataStore((state) => state.data?.aliases);
  return mergeShared(saved, pending, aliases);
}

/** Why a decision that applies to everyone has no action here. */
export const maintainersOnly = 'Applies to everyone. Only maintainers can change it.';

/** Only maintainers set or clear them; the Worker enforces the same. */
export function useCanShareDecisions(): boolean {
  return useAuthStore((state) => !!apiUrl && state.user?.role === 'maintainer');
}
