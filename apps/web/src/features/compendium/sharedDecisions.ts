import { create } from 'zustand';
import { resolveAlias, type Aliases } from '@clarity/core';
import type { CompendiumDecision, MarkAction, Marks } from '@clarity/core/marks';
import { apiUrl, type User } from '../../services/api';
import { errorMessage } from '../../services/http';
import { sessionToken } from '../../services/session';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useMarksStore } from '../marks/store';

/**
 * Maintainers' decisions about entries, shared with everyone through config/marks.json:
 * - no-match: no Compendium row right now; ends by itself at a confident match
 * - not-needed: the entry needs no Compendium row
 */
export type SharedKind = CompendiumDecision['kind'];
export interface SharedDecision {
  kind: SharedKind;
  /** Unset until the save is acknowledged. */
  by?: number;
  at?: string;
}
type DecisionAction = Extract<MarkAction, { hashes: number[] }>;
export type SharedDecisions = ReadonlyMap<number, SharedDecision>;
type Saved = NonNullable<Marks['compendium']>;
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
interface Unsaved {
  /** Not yet acknowledged, by main entry: the decision, or null for a cleared one. */
  pending: Pending;
  error: string | null;
}
const nothing: Unsaved = { pending: new Map(), error: null };
interface SavesState {
  /** Unsaved decisions by the account that made them: no other one sees or writes them. */
  accounts: ReadonlyMap<User['id'] | undefined, Unsaved>;
  set(hashes: readonly number[], kind: SharedKind | null): void;
  retry(): void;
  /** Gives up on decisions that could not be saved. */
  discard(): void;
}
const account = () => useAuthStore.getState().user?.id;
/** What the account (the signed-in one) has not saved yet. */
export const unsaved = (owner = account()): Unsaved =>
  useSharedSaves.getState().accounts.get(owner) ?? nothing;

function keep(owner: User['id'] | undefined, change: Partial<Unsaved>) {
  const accounts = new Map(useSharedSaves.getState().accounts);
  const next = { ...unsaved(owner), ...change };
  if (next.pending.size) accounts.set(owner, next);
  else accounts.delete(owner);
  useSharedSaves.setState({ accounts });
}

export const useSharedSaves = create<SavesState>(() => ({
  accounts: new Map(),
  set(hashes, kind) {
    const pending = new Map(unsaved().pending);
    for (const hash of hashes) pending.set(hash, kind);
    keep(account(), { pending, error: null });
    window.addEventListener('beforeunload', keepPage);
    void drain();
  },
  retry() {
    keep(account(), { error: null });
    void drain();
  },
  discard() {
    keep(account(), nothing);
  },
}));

export function useUnsaved(): Unsaved {
  const user = useAuthStore((state) => state.user?.id);
  return useSharedSaves((state) => state.accounts.get(user) ?? nothing);
}

/** Leaving the page would lose decisions the server has not acknowledged: the browser asks first. */
function keepPage(event: BeforeUnloadEvent) {
  if (useSharedSaves.getState().accounts.size) event.preventDefault();
  else window.removeEventListener('beforeunload', keepPage);
}

/**
 * The next request: the first pending decision's kind, for every entry that has it. Read again for
 * each attempt, so a decision undone meanwhile is never written.
 */
function nextBatch(pending: Pending): { entries: number[]; change: DecisionAction } {
  const kind: SharedKind | null = [...pending.values()][0];
  const entries = [...pending].flatMap(([hash, value]) => (value === kind ? [hash] : []));
  if (kind) {
    const hashes = entries.slice(0, batchSize);
    return { entries: hashes, change: { action: 'compendium-set', kind, hashes } };
  }
  // A clear removes every stored decision that shows on the entry, as stored right now.
  const aliases = useDataStore.getState().data?.aliases;
  const stored = new Map<number, number[]>();
  for (const key of Object.keys(useMarksStore.getState().marks.compendium ?? {}).map(Number)) {
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
  const owner = account();
  try {
    for (let attempt = 1; !whyNotSent(owner) && unsaved(owner).pending.size;) {
      try {
        await marksReady();
        const { pending } = unsaved(owner);
        if (whyNotSent(owner) || !pending.size) break;
        const { entries, change } = nextBatch(pending);
        if (change.hashes.length) await useMarksStore.getState().save(change);
        // A response the marks store dropped (the sign-in changed) acknowledges nothing here.
        if (whyNotSent(owner)) break;
        const rest = new Map(unsaved(owner).pending);
        for (const hash of entries) if (rest.get(hash) === pending.get(hash)) rest.delete(hash);
        keep(owner, { pending: rest });
        attempt = 1;
      } catch (error) {
        // The actions are idempotent: after a lost race the marks are read and written again.
        if (attempt++ < 3) await new Promise((resolve) => setTimeout(resolve, 400));
        else {
          keep(owner, { error: errorMessage(error) });
          break;
        }
      }
    }
  } finally {
    draining = false;
    // Stopped part-way: on this account's return, the notice says why and offers Retry.
    const why = whyNotSent(owner);
    if (why && unsaved(owner).pending.size && !unsaved(owner).error) keep(owner, { error: why });
    // Another account decided something while this one's request was on its way.
    if (unsaved().pending.size && !unsaved().error) void drain();
  }
}

/** Why a request must not go out for this account now; undefined when it may. */
function whyNotSent(owner: User['id'] | undefined): string | undefined {
  const { user, token } = useAuthStore.getState();
  try {
    // A request carries the stored session, which another tab can have replaced.
    if (!user || user.id !== owner || token === null || token !== sessionToken())
      return 'The sign-in changed before they were sent.';
  } catch {
    return 'The sign-in changed before they were sent.';
  }
  return mayShare(user) ? undefined : 'Changing decisions for everyone is turned off for now.';
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
  const saved = useMarksStore((state) => state.marks.compendium);
  const { pending } = useUnsaved();
  const aliases = useDataStore((state) => state.data?.aliases);
  return mergeShared(saved, pending, aliases);
}

/** Only maintainers set or clear them, while the Worker accepts it; the Worker enforces the same. */
const mayShare = (user: User | null) =>
  !!apiUrl && user?.role === 'maintainer' && user.compendiumDecisions === true;
export function useCanShareDecisions(): boolean {
  return useAuthStore((state) => mayShare(state.user));
}

/** Why this account cannot change a decision that applies to everyone; undefined when it can. */
export function useWhyNotShared(): string | undefined {
  const can = useCanShareDecisions();
  const maintainer = useAuthStore((state) => !!apiUrl && state.user?.role === 'maintainer');
  if (can) return undefined;
  return maintainer
    ? 'Applies to everyone. Changing it is turned off for now.'
    : 'Applies to everyone. Only maintainers can change it.';
}
