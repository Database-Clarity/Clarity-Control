import { useMemo } from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { hashSchema, tooltipSchema, type Tooltip } from '@clarity/core';
import type { Change, SaveConflict } from '../services/api';
import { replaceDraft } from '../services/save/drafts';
import { fieldValue, setField } from '../features/conflicts/reducer';
import { rebaseConflict } from '../features/conflicts/rebase';
import { markersIn, openConflicts, type ConflictSummary } from '../features/conflicts/summary';
import { useDataStore } from './data';
import { useDraftStore } from './drafts';
import { rememberSaved } from './savedOverlay';
import type { Drafts } from '../services/draftStorage';

/**
 * Save conflicts being resolved inline. The text lives in the drafts themselves (marker blocks
 * the editor resolves), so a reload keeps it; this store holds what the markers cannot: the
 * common ancestor and both sides for the Compare view, and the non-text fields (`$exists`, a
 * Compendium link, the category…) that still need a choice. It is saved on this device per
 * account, like the drafts, so a reload does not turn an open question into "mine wins".
 */
export const sessionSchema = z.object({
  hash: hashSchema,
  base: tooltipSchema.nullable(),
  head: tooltipSchema.nullable(),
  mine: tooltipSchema,
  /** Non-text fields: the choice once made, null while open. */
  rows: z.record(z.string(), z.enum(['mine', 'theirs']).nullable()),
  /** Published only once the draft write settles. Absent on legacy sessions. */
  storedAt: z.number().finite().optional(),
  /** Server time of the rejected save (its Date header), dating `head` for the saved overlay. */
  serverAt: z.number().finite().positive().optional(),
});
export type ConflictSession = z.infer<typeof sessionSchema>;
export type RowChoice = 'mine' | 'theirs';

export const conflictsKey = (scope: string) => `clarity-conflicts:v1:${scope}`;
export const conflictSessionKey = (scope: string, hash: number) =>
  `clarity-conflicts:v2:${scope}:${hash}`;

export interface BeginResult {
  /** Marker blocks written, tooltips rebased, texts that merged without a conflict, open rows. */
  markers: number;
  tooltips: number;
  merged: number;
  rows: number;
}

export interface ConflictDeps {
  drafts: typeof useDraftStore;
  storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | undefined;
  /**
   * Makes the server's version (null: none) the one the editor shows as saved. `serverAt` is the
   * server's clock when it reported that version; absent, the browser clock dates it.
   */
  applyHead(hash: number, head: Tooltip | null, serverAt?: number): void;
}

export interface ConflictState {
  scope: string | null;
  sessions: Record<number, ConflictSession>;
  /** Rebases the drafts of a rejected save on the server's versions and opens the resolution. */
  begin(conflicts: SaveConflict[], kept?: Change[], serverAt?: number): BeginResult;
  choose(hash: number, field: string, choice: RowChoice): void;
  /** Merges in what another tab stored for the same account (after Reload). */
  refresh(): void;
  /** Open conflicts of every tooltip, in hash order. */
  open(): ConflictSummary[];
  start(): () => void;
}

function readSessions(
  storage: ReturnType<ConflictDeps['storage']>,
  scope: string,
): Record<number, ConflictSession> {
  const sessions: Record<number, ConflictSession> = {};
  try {
    if (!storage) return sessions;
    // Migrate the old account snapshot once. New writes are isolated by tooltip, so two tabs
    // cannot replace each other's session sets, even when their writes overlap.
    try {
      const raw = storage.getItem(conflictsKey(scope));
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed)) {
          const result = sessionSchema.safeParse(value);
          if (!result.success) continue;
          const key = conflictSessionKey(scope, result.data.hash);
          if (!storage.getItem(key)) storage.setItem(key, JSON.stringify(result.data));
        }
      }
      storage.removeItem(conflictsKey(scope));
    } catch {
      // A damaged legacy snapshot or failed migration must not hide newer sessions.
    }
    const prefix = `clarity-conflicts:v2:${scope}:`;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const result = sessionSchema.safeParse(JSON.parse(storage.getItem(key) ?? 'null'));
        if (result.success && key === conflictSessionKey(scope, result.data.hash))
          sessions[result.data.hash] = result.data;
      } catch {
        // An unreadable session must not hide other tooltips' conflicts.
      }
    }
  } catch {
    // An unreadable copy starts empty; the marker blocks in the drafts are untouched.
  }
  return sessions;
}

/** Unresolved non-text rows per tooltip. */
export function rowCounts(
  sessions: Readonly<Record<number, ConflictSession>>,
): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const session of Object.values(sessions)) {
    const open = Object.values(session.rows).filter((choice) => choice === null).length;
    if (open > 0) counts[session.hash] = open;
  }
  return counts;
}

export function createConflictStore(deps: ConflictDeps) {
  return create<ConflictState>((set, get) => {
    const observedDrafts = new Set<number>();
    // Only unpersisted local edits survive a refresh when their key is absent from storage.
    const dirtySessions = new Set<number>();
    const parked = new Map<
      string,
      {
        sessions: Record<number, ConflictSession>;
        dirty: Set<number>;
        drafts: Drafts;
      }
    >();
    function publish(scope: string, sessions: Record<number, ConflictSession>, dirty: Set<number>) {
      const storage = deps.storage();
      if (!storage) throw new Error('Conflict storage is unavailable');
      for (const hash of dirty) {
        const session = sessions[hash];
        if (session) {
          const published = { ...session, storedAt: Date.now() };
          storage.setItem(conflictSessionKey(scope, hash), JSON.stringify(published));
          sessions[hash] = published;
        } else storage.removeItem(conflictSessionKey(scope, hash));
        dirty.delete(hash);
      }
    }
    function persist() {
      const { scope } = get();
      if (scope === null) return;
      const { pending, error } = deps.drafts.getState();
      for (const hash of dirtySessions) {
        const session = get().sessions[hash];
        // Do not expose a session before another tab can read its draft from IndexedDB.
        if (session && (pending > 0 || error)) continue;
        try {
          const storage = deps.storage();
          if (!storage) continue;
          if (session) {
            const published = { ...session, storedAt: Date.now() };
            storage.setItem(conflictSessionKey(scope, hash), JSON.stringify(published));
            set({ sessions: { ...get().sessions, [hash]: published } });
          } else storage.removeItem(conflictSessionKey(scope, hash));
          dirtySessions.delete(hash);
        } catch {
          // Keep failed local edits in memory, including through a refresh.
        }
      }
    }
    function commit(sessions: Record<number, ConflictSession>) {
      const previous = get().sessions;
      set({ sessions });
      for (const hash of new Set([...Object.keys(previous), ...Object.keys(sessions)])) {
        if (previous[Number(hash)] !== sessions[Number(hash)]) dirtySessions.add(Number(hash));
      }
      persist();
    }
    const unresolvedRows = (session: ConflictSession) =>
      Object.values(session.rows).filter((choice) => choice === null).length;
    /** Drops sessions whose conflict is over: no marker blocks, no open rows, or no draft left. */
    function prune(onlyHash?: number) {
      const { sessions } = get();
      const { drafts, pending, external, readStartedAt } = deps.drafts.getState();
      let next = sessions;
      for (const session of Object.values(sessions)) {
        if (onlyHash !== undefined && session.hash !== onlyHash) continue;
        const draft = drafts[session.hash];
        // Our pending/external flags cannot describe another tab's writes. A snapshot
        // read before publication cannot prove that an imported session is finished.
        if (
          !observedDrafts.has(session.hash) &&
          (pending > 0 ||
            external ||
            (session.storedAt !== undefined && readStartedAt <= session.storedAt))
        )
          continue;
        const done =
          !draft ||
          (unresolvedRows(session) === 0 && Object.keys(markersIn(draft.next)).length === 0);
        if (!done) continue;
        if (next === sessions) next = { ...sessions };
        delete next[session.hash];
      }
      if (next !== sessions) commit(next);
    }

    function refreshSessions(onlyHash?: number) {
      const { scope } = get();
      if (scope === null) return;
      const stored = readSessions(deps.storage(), scope);
      // Storage is authoritative for deletions. Only local edits not yet stored are kept.
      const sessions: Record<number, ConflictSession> = {};
      for (const [key, session] of Object.entries(get().sessions)) {
        if (onlyHash !== undefined && Number(key) !== onlyHash) {
          sessions[Number(key)] = session;
          continue;
        }
        if (dirtySessions.has(Number(key))) sessions[Number(key)] = session;
        else if (stored[Number(key)]?.storedAt !== session.storedAt)
          observedDrafts.delete(Number(key));
      }
      for (const [key, session] of Object.entries(stored)) {
        if (onlyHash !== undefined && Number(key) !== onlyHash) continue;
        const mine = get().sessions[Number(key)];
        if (!mine) {
          sessions[Number(key)] = session;
          continue;
        }
        const rows = { ...session.rows };
        for (const [field, choice] of Object.entries(mine.rows))
          if (choice !== null || !(field in rows)) rows[field] = choice;
        sessions[Number(key)] = { ...mine, rows, storedAt: session.storedAt };
      }
      // Reading another tab's sessions is not a local edit and must not write them back.
      set({ sessions });
      prune(onlyHash);
    }

    return {
      scope: null,
      sessions: {},
      begin(conflicts, kept = [], serverAt) {
        const sessions = { ...get().sessions };
        const result: BeginResult = { markers: 0, tooltips: 0, merged: 0, rows: 0 };
        const drafts = deps.drafts.getState();
        for (const conflict of conflicts) {
          const { hash, head, base, next } = conflict;
          // Even an identical rebase counts as observed: replaceDraft may remove its draft.
          observedDrafts.add(hash);
          const rebased = rebaseConflict(conflict);
          const rows: Record<string, null> = {};
          if (rebased) {
            replaceDraft(rebased.base, rebased.next, true);
            deps.applyHead(hash, head, serverAt);
            result.markers += rebased.markers;
            result.merged += rebased.mergedLanguages.length;
            for (const field of rebased.rows) rows[field] = null;
          } else {
            // The tooltip exists on one side only: keep my draft and ask what to do with it.
            if (!drafts.drafts[hash]) drafts.updateDraft(base ?? head ?? next, () => next);
            if (head) deps.applyHead(hash, head, serverAt);
            rows['$exists'] = null;
          }
          result.rows += Object.keys(rows).length;
          result.tooltips++;
          sessions[hash] = {
            hash,
            base,
            head,
            mine: next,
            rows,
            ...(serverAt === undefined ? {} : { serverAt }),
          };
        }
        // Changes made through a one-shot review (Compendium link, drift) were never drafts:
        // keep the ones that did not conflict, so closing the review loses nothing.
        for (const change of kept) {
          const current = deps.drafts.getState();
          if (current.drafts[change.hash]) continue;
          // A new tooltip has no server ancestor. Keep its complete snapshot as a draft;
          // openDraftSaveReview restores the null API base from its absence in saved data.
          deps.drafts.setState({
            drafts: {
              ...current.drafts,
              [change.hash]: {
                base: change.base ?? { hash: change.hash, text: {}, associated: [] },
                next: change.next,
              },
            },
          });
          current.retry();
        }
        commit(sessions);
        prune();
        return result;
      },
      choose(hash, field, choice) {
        // A stale Compare view must not answer a question already resolved in another tab.
        refreshSessions(hash);
        const session = get().sessions[hash];
        if (!session || !(field in session.rows)) return;
        observedDrafts.add(hash);
        const draftStore = deps.drafts.getState();
        const draft = draftStore.drafts[hash];
        if (field === '$exists') {
          if (session.rows[field] !== null) return;
          if (session.head === null) {
            // Deleted on the server while I edited. Mine: bring it back (saved as a new tooltip).
            // Theirs: accept the deletion and let my draft go.
            // The server reported the deletion when the save was rejected, not now.
            deps.applyHead(hash, null, session.serverAt);
            if (choice === 'theirs') draftStore.discard(hash);
          } else if (choice === 'mine') {
            // They created it meanwhile. Mine: save on top of theirs.
            replaceDraft(session.head, draft?.next ?? session.mine, true);
          } else draftStore.discard(hash);
        } else if (session.head) {
          const source = choice === 'theirs' ? session.head : session.mine;
          draftStore.updateDraft(session.head, (tooltip) =>
            setField(tooltip, field, fieldValue(source, field)),
          );
        }
        const current = get().sessions[hash];
        if (!current) return;
        commit({
          ...get().sessions,
          [hash]: { ...current, rows: { ...current.rows, [field]: choice } },
        });
        prune();
      },
      refresh() {
        refreshSessions();
      },
      open() {
        return openConflicts(deps.drafts.getState().drafts, rowCounts(get().sessions));
      },
      start() {
        let scope: string | null = null;
        const stopStored = deps.drafts.getState().onStored((owner, drafts) => {
          const account = owner ?? 'signed-out';
          const pending = parked.get(account);
          // Older writes cannot publish a session whose draft was changed again meanwhile.
          if (!pending || pending.drafts !== drafts) return;
          publish(account, pending.sessions, pending.dirty);
          parked.delete(account);
        });
        const observe = (
          state: ReturnType<typeof deps.drafts.getState>,
          previous?: ReturnType<typeof deps.drafts.getState>,
        ) => {
          const owner = state.hydrated ? (state.owner ?? 'signed-out') : null;
          let failedPrevious = false;
          if (owner !== scope && scope !== null && dirtySessions.size > 0) {
            parked.set(scope, {
              sessions: { ...get().sessions },
              dirty: new Set(dirtySessions),
              drafts: previous?.drafts ?? state.drafts,
            });
            failedPrevious = (previous?.pending ?? 0) === 0;
          }
          if (!state.hydrated) {
            scope = null;
            observedDrafts.clear();
            dirtySessions.clear();
            set({ scope: null, sessions: {} });
            if (failedPrevious)
              deps.drafts.setState({
                previousAccountError: `Conflict choices for your previous account were NOT stored. ${previous?.error ?? ''} Keep this tab open, sign back in to that account, and retry draft storage.`,
              });
            return;
          }
          // Hydrated owners include the signed-out bucket, so this cannot be null.
          const account = owner!;
          if (owner !== scope) {
            scope = account;
            observedDrafts.clear();
            dirtySessions.clear();
            const pending = parked.get(account);
            const sessions = readSessions(deps.storage(), account);
            if (pending) {
              for (const hash of pending.dirty) {
                dirtySessions.add(hash);
                if (pending.sessions[hash]) sessions[hash] = pending.sessions[hash]!;
                else delete sessions[hash];
              }
              parked.delete(account);
            }
            set({ scope: account, sessions });
          } else if (
            previous &&
            state.readRevision === previous.readRevision &&
            state.readStartedAt === previous.readStartedAt &&
            state.stored === previous.stored
          ) {
            // A local edit/discard can finish even an imported session. A storage reload
            // must instead prove freshness through its read start time above.
            for (const hash of Object.keys(get().sessions))
              if (state.drafts[hash] !== previous.drafts[hash]) observedDrafts.add(Number(hash));
          }
          if (
            previous &&
            (state.readRevision !== previous.readRevision ||
              state.readStartedAt !== previous.readStartedAt)
          )
            get().refresh();
          prune();
          persist();
          if (failedPrevious)
            deps.drafts.setState({
              previousAccountError: `Conflict choices for your previous account were NOT stored. ${previous?.error ?? ''} Keep this tab open, sign back in to that account, and retry draft storage.`,
            });
        };
        observe(deps.drafts.getState());
        const stopDrafts = deps.drafts.subscribe(observe);
        return () => {
          stopDrafts();
          stopStored();
        };
      },
    };
  });
}

/** Makes the server's version (null: deleted) the one the editor shows as saved. */
export function applyHeadToData(hash: number, head: Tooltip | null, serverAt?: number): void {
  if (head) rememberSaved([head], [], Date.now(), serverAt);
  else rememberSaved([], [hash], Date.now(), serverAt);
  useDataStore.setState(({ data }) => {
    if (!data) return {};
    const tooltips = { ...data.bundle.tooltips };
    if (head) tooltips[hash] = head;
    else delete tooltips[hash];
    return { data: { ...data, bundle: { ...data.bundle, tooltips } } };
  });
}

export const useConflictStore = createConflictStore({
  drafts: useDraftStore,
  storage() {
    try {
      return localStorage;
    } catch {
      return undefined;
    }
  },
  applyHead: applyHeadToData,
});

const conflictEvidence = new WeakMap<Drafts, WeakMap<ConflictState['sessions'], string>>();
function evidenceFor(drafts: Drafts, sessions: ConflictState['sessions']) {
  let bySession = conflictEvidence.get(drafts);
  if (!bySession) conflictEvidence.set(drafts, (bySession = new WeakMap()));
  let evidence = bySession.get(sessions);
  if (evidence === undefined) {
    evidence = JSON.stringify(openConflicts(drafts, rowCounts(sessions)));
    bySession.set(sessions, evidence);
  }
  return evidence;
}

/** Every tooltip with an open conflict (marker blocks in a draft, or a row to choose), live. */
export function useOpenConflicts(): ConflictSummary[] {
  const sessions = useConflictStore((state) => state.sessions);
  // Ordinary typing does not change conflict counts. Subscribe to the complete summary
  // evidence, rather than invalidating the shell and every conflict consumer per character.
  // Status, storage, and React snapshot notifications share the same immutable
  // draft/session evidence; repeated consumers must not rescan every language.
  const evidence = useDraftStore((state) => evidenceFor(state.drafts, sessions));
  return useMemo(() => JSON.parse(evidence) as ConflictSummary[], [evidence]);
}

/**
 * Another tab changed this account's drafts while conflicts are open here: everything that would
 * write or save pauses until the user answers Reload or Keep mine.
 */
export function usePausedForOtherTab(): boolean {
  const external = useDraftStore((state) => state.external);
  const open = useOpenConflicts().length > 0;
  return external && open;
}
