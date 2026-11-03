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
  /** Makes the server's version (null: none) the one the editor shows as saved. */
  applyHead(hash: number, head: Tooltip | null): void;
}

export interface ConflictState {
  scope: string | null;
  sessions: Record<number, ConflictSession>;
  /** Rebases the drafts of a rejected save on the server's versions and opens the resolution. */
  begin(conflicts: SaveConflict[], kept?: Change[]): BeginResult;
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
    function commit(sessions: Record<number, ConflictSession>) {
      const previous = get().sessions;
      const scope = get().scope;
      set({ sessions });
      if (scope === null) return;
      try {
        const storage = deps.storage();
        for (const hash of new Set([...Object.keys(previous), ...Object.keys(sessions)])) {
          if (previous[Number(hash)] === sessions[Number(hash)]) continue;
          const key = conflictSessionKey(scope, Number(hash));
          const session = sessions[Number(hash)];
          if (session) storage?.setItem(key, JSON.stringify(session));
          else storage?.removeItem(key);
        }
      } catch {
        // Best effort: without storage the open rows last until the tab closes.
      }
    }
    const unresolvedRows = (session: ConflictSession) =>
      Object.values(session.rows).filter((choice) => choice === null).length;
    /** Drops sessions whose conflict is over: no marker blocks, no open rows, or no draft left. */
    function prune() {
      const { sessions } = get();
      const { drafts, pending, external } = deps.drafts.getState();
      let next = sessions;
      for (const session of Object.values(sessions)) {
        const draft = drafts[session.hash];
        if (draft) observedDrafts.add(session.hash);
        // Imported drafts may still be in flight or awaiting Reload / Keep mine. Once
        // storage is settled, a missing draft means the session is orphaned.
        if (!draft && !observedDrafts.has(session.hash) && (pending > 0 || external)) continue;
        const done =
          !draft ||
          (unresolvedRows(session) === 0 && Object.keys(markersIn(draft.next)).length === 0);
        if (!done) continue;
        if (next === sessions) next = { ...sessions };
        delete next[session.hash];
      }
      if (next !== sessions) commit(next);
    }

    return {
      scope: null,
      sessions: {},
      begin(conflicts, kept = []) {
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
            deps.applyHead(hash, head);
            result.markers += rebased.markers;
            result.merged += rebased.mergedLanguages.length;
            for (const field of rebased.rows) rows[field] = null;
          } else {
            // The tooltip exists on one side only: keep my draft and ask what to do with it.
            if (!drafts.drafts[hash]) drafts.updateDraft(base ?? head ?? next, () => next);
            if (head) deps.applyHead(hash, head);
            rows['$exists'] = null;
          }
          result.rows += Object.keys(rows).length;
          result.tooltips++;
          sessions[hash] = { hash, base, head, mine: next, rows };
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
        const session = get().sessions[hash];
        if (!session || !(field in session.rows)) return;
        const draftStore = deps.drafts.getState();
        const draft = draftStore.drafts[hash];
        if (field === '$exists') {
          if (session.rows[field] !== null) return;
          if (session.head === null) {
            // Deleted on the server while I edited. Mine: bring it back (saved as a new tooltip).
            // Theirs: accept the deletion and let my draft go.
            deps.applyHead(hash, null);
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
        const { scope } = get();
        if (scope === null) return;
        const stored = readSessions(deps.storage(), scope);
        // Keep local-only sessions too: a failed setItem must not lose unresolved rows.
        const sessions = { ...get().sessions };
        for (const [key, session] of Object.entries(stored)) {
          const mine = get().sessions[Number(key)];
          if (!mine) {
            sessions[Number(key)] = session;
            continue;
          }
          const rows = { ...session.rows };
          for (const [field, choice] of Object.entries(mine.rows))
            if (choice !== null || !(field in rows)) rows[field] = choice;
          sessions[Number(key)] = { ...mine, rows };
        }
        // Reading another tab's sessions is not a local edit and must not write them back.
        set({ sessions });
        prune();
      },
      open() {
        return openConflicts(deps.drafts.getState().drafts, rowCounts(get().sessions));
      },
      start() {
        let scope: string | null = null;
        const observe = (state: ReturnType<typeof deps.drafts.getState>) => {
          if (!state.hydrated) {
            scope = null;
            observedDrafts.clear();
            set({ scope: null, sessions: {} });
            return;
          }
          const owner = state.owner ?? 'signed-out';
          if (owner !== scope) {
            scope = owner;
            observedDrafts.clear();
            set({ scope: owner, sessions: readSessions(deps.storage(), owner) });
          }
          prune();
        };
        observe(deps.drafts.getState());
        return deps.drafts.subscribe(observe);
      },
    };
  });
}

/** Makes the server's version (null: deleted) the one the editor shows as saved. */
export function applyHeadToData(hash: number, head: Tooltip | null): void {
  if (head) rememberSaved([head]);
  else rememberSaved([], [hash]);
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

/** Every tooltip with an open conflict (marker blocks in a draft, or a row to choose), live. */
export function useOpenConflicts(): ConflictSummary[] {
  const sessions = useConflictStore((state) => state.sessions);
  const drafts = useDraftStore((state) => state.drafts);
  return useMemo(() => openConflicts(drafts, rowCounts(sessions)), [drafts, sessions]);
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
