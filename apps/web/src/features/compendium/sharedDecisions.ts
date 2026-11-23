import { create } from 'zustand';
import { resolveAlias, type Aliases } from '@clarity/core';
import type { MarkAction, Marks } from '@clarity/core/marks';
import { apiUrl } from '../../services/api';
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
/** Entries per request; larger sets are split. */
const batchSize = 200;

/** An entry grouped after its decision was made shows it on its main entry. */
function mainEntry(hash: number, aliases: Aliases | undefined) {
  try {
    return aliases ? resolveAlias(hash, aliases) : hash;
  } catch {
    return hash;
  }
}

interface SavesState {
  /** Not yet acknowledged, by stored hash: the decision, or null for a cleared one. */
  pending: ReadonlyMap<number, SharedKind | null>;
  error: string | null;
  set(hashes: readonly number[], kind: SharedKind | null): void;
  retry(): void;
  /** Gives up on decisions that could not be saved. */
  discard(): void;
}

export const useSharedSaves = create<SavesState>((set, get) => ({
  pending: new Map(),
  error: null,
  set(hashes, kind) {
    const pending = new Map(get().pending);
    for (const hash of hashes) pending.set(hash, kind);
    if (!kind) {
      const aliases = useDataStore.getState().data?.aliases;
      for (const key of Object.keys(savedIn(useMarksStore.getState().marks) ?? {}))
        if (hashes.includes(mainEntry(Number(key), aliases))) pending.set(Number(key), null);
    }
    set({ pending, error: null });
    void drain();
  },
  retry() {
    set({ error: null });
    void drain();
  },
  discard() {
    set({ pending: new Map(), error: null });
  },
}));

let draining = false;
/** One request at a time; decisions made meanwhile join a later one. */
async function drain() {
  if (draining) return;
  draining = true;
  const { user } = useAuthStore.getState();
  // Another account's session must neither write nor show what this one decided.
  const left = () => useAuthStore.getState().user?.id !== user?.id;
  try {
    for (;;) {
      const { pending } = useSharedSaves.getState();
      if (!pending.size) return;
      const kind: SharedKind | null = [...pending.values()][0];
      const hashes = [...pending]
        .flatMap(([hash, value]) => (value === kind ? [hash] : []))
        .slice(0, batchSize);
      await write(
        (kind
          ? { action: 'compendium-set', kind, hashes }
          : { action: 'compendium-clear', hashes }) as unknown as MarkAction,
        left,
      );
      if (left()) return useSharedSaves.getState().discard();
      const rest = new Map(useSharedSaves.getState().pending);
      for (const hash of hashes) if (rest.get(hash) === kind) rest.delete(hash);
      useSharedSaves.setState({ pending: rest });
    }
  } catch (error) {
    if (left()) useSharedSaves.getState().discard();
    else useSharedSaves.setState({ error: errorMessage(error) });
  } finally {
    draining = false;
  }
}

/** The actions are idempotent, so a lost race reloads the marks and writes again. */
async function write(change: MarkAction, left: () => boolean) {
  for (let attempt = 1; !left(); attempt++) {
    try {
      if (!useMarksStore.getState().writable) await useMarksStore.getState().reload();
      return await useMarksStore.getState().save(change);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

let merged: {
  saved?: Saved;
  pending?: SavesState['pending'];
  aliases?: Aliases;
  value: SharedDecisions;
} = { value: new Map() };
/** The decisions as shown: the saved ones with the unacknowledged ones applied, by main entry. */
function mergeShared(
  saved: Saved | undefined,
  pending: SavesState['pending'],
  aliases: Aliases | undefined,
): SharedDecisions {
  if (merged.saved === saved && merged.pending === pending && merged.aliases === aliases)
    return merged.value;
  const stored = new Map<number, SharedDecision>(
    Object.entries(saved ?? {}).map(([hash, decision]) => [Number(hash), decision]),
  );
  for (const [hash, kind] of pending)
    if (kind) stored.set(hash, { kind });
    else stored.delete(hash);
  const value = new Map<number, SharedDecision>();
  for (const [hash, decision] of stored) {
    const main = mainEntry(hash, aliases);
    // The main entry's own decision outranks a grouped one's.
    if (main === hash || !stored.has(main)) value.set(main, decision);
  }
  merged = { saved, pending, aliases, value };
  return value;
}

export function useSharedDecisions(): SharedDecisions {
  const saved = useMarksStore((state) => savedIn(state.marks));
  const pending = useSharedSaves((state) => state.pending);
  const aliases = useDataStore((state) => state.data?.aliases);
  return mergeShared(saved, pending, aliases);
}

/** Why a decision that applies to everyone has no action here. */
export const maintainersOnly = 'Applies to everyone. Only maintainers can change it.';

/** Only maintainers set or clear them; the Worker enforces the same. */
export function useCanShareDecisions(): boolean {
  return useAuthStore((state) => !!apiUrl && state.user?.role === 'maintainer');
}
