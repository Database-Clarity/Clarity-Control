import { create } from 'zustand';
import { type Lang, type Tooltip } from '@clarity/core';
import { draftStorage, type Drafts, type DraftStorage } from '../services/draftStorage';
import { errorMessage } from '../services/http';
import { reconcileDrafts } from '../features/conflicts/rebase';

export interface AdoptionResult {
  adopted: number;
  left: number;
}
interface DraftState {
  drafts: Drafts;
  hydrated: boolean;
  pending: number;
  error: string | null;
  /** A failed write of an account we already left. Shown, but never blocks the current account. */
  previousAccountError: string | null;
  /** Account whose drafts are loaded; null = signed out (the unowned bucket). */
  owner: string | null;
  /** Bumped on every account switch, so long operations can tell the drafts they started with. */
  generation: number;
  /** Unowned drafts waiting for an adopt / keep-separate decision (only while signed in). */
  unowned: number;
  /** Another tab wrote this account's drafts since this tab last read or wrote them. */
  external: boolean;
  /** The drafts as this tab last read or wrote them in storage: the common ancestor for a merge. */
  stored: Drafts;
  /** Start of the latest successful storage read, for cross-tab conflict orphan checks. */
  readStartedAt: number;
  /** Successful reads, including reads whose wall-clock timestamps are equal. */
  readRevision: number;
  hydrate(): Promise<void>;
  /** Switches to the drafts of this account (null = signed out). Same account: no-op. */
  activate(userId: string | number | null): Promise<void>;
  /** Moves unowned drafts into the signed-in account. Never overwrites or drops a draft. */
  adopt(): Promise<AdoptionResult>;
  keepSeparate(): void;
  dismissPreviousAccountError(): void;
  edit(base: Tooltip, lang: Lang, text: string, author: string): void;
  updateDraft(base: Tooltip, update: (tooltip: Tooltip) => Tooltip): void;
  updateDrafts(updates: { base: Tooltip; update: (tooltip: Tooltip) => Tooltip }[]): void;
  discard(hash: number): void;
  /**
   * Answers "another tab changed the drafts" with Reload: reads what is stored now and merges it
   * with this tab's drafts (`merge(ancestor, mine, theirs)`), then stores the result.
   */
  reloadFromStorage(
    merge: (ancestor: Drafts, mine: Drafts, theirs: Drafts) => Drafts,
  ): Promise<void>;
  /** ...or with Keep mine: this tab's drafts overwrite what the other tab stored. */
  keepMine(): Promise<void>;
  /** Calls back after a draft is deliberately discarded (not when it is saved or reverted). */
  onDiscard(listener: (hash: number) => void): () => void;
  /** Runs after a bound account write, before it is considered safely stored. */
  onStored(listener: (owner: string | null, drafts: Drafts) => void): () => void;
  retry(): void;
  flush(): Promise<void>;
}

const separateKey = (owner: string) => `clarity-drafts-keep-separate:${owner}`;
function keptSeparate(owner: string): boolean {
  try {
    return sessionStorage.getItem(separateKey(owner)) === '1';
  } catch {
    return false;
  }
}
function rememberSeparate(owner: string) {
  try {
    sessionStorage.setItem(separateKey(owner), '1');
  } catch {
    // Without session storage the choice is asked again next load. Nothing is lost.
  }
}

export function createDraftStore(storage: DraftStorage) {
  let queue = Promise.resolve();
  let hydration: Promise<void> | undefined;
  let owner: string | null = null;
  let generation = 0;
  const bucket = (id: string | null) =>
    id === null ? storage : (storage.forUser?.(id) ?? storage);
  let target = bucket(null);
  let unwatch: (() => void) | undefined;
  /** Resolves when everything queued so far, including writes queued meanwhile, has finished. */
  const settled = async () => {
    for (let last = queue; ; last = queue) {
      await last;
      if (last === queue) return;
    }
  };
  const discardListeners = new Set<(hash: number) => void>();
  const storedListeners = new Set<(owner: string | null, drafts: Drafts) => void>();
  // Keep failed snapshots in this tab until their account can retry them. A switch must
  // not turn a failed write into a successful read of an older disk snapshot.
  const unsaved = new Map<
    string | null,
    { ancestor: Drafts; drafts: Drafts; error: string | null }
  >();
  return create<DraftState>((set, get) => {
    function persist(drafts: Drafts) {
      // Bind the bucket now: a later account switch must never redirect this write.
      const destination = target;
      const writer = owner;
      const writerGeneration = generation;
      const recovery = { ancestor: get().stored, drafts, error: null as string | null };
      unsaved.set(writer, recovery);
      set((state) => ({ pending: state.pending + 1 }));
      queue = queue.then(async () => {
        try {
          await destination.write(drafts);
          // A later queued snapshot must merge against the last successful write,
          // even when that write belongs to an account we have already left.
          const latest = unsaved.get(writer);
          if (latest) latest.ancestor = drafts;
          for (const listener of storedListeners) listener(writer, drafts);
          if (unsaved.get(writer) === recovery) unsaved.delete(writer);
          if (writerGeneration === generation) set({ error: null, stored: drafts });
        } catch (error) {
          recovery.error = `Drafts are NOT safely stored: ${errorMessage(error).replace(/\.+$/, '')}. Keep this tab open and retry.`;
          if (writerGeneration === generation)
            set({
              error: recovery.error,
            });
          else
            set({
              previousAccountError: `The last edit of your previous account${writer ? ` (${writer})` : ''} was NOT stored: ${errorMessage(error)}. Sign back in to it and check your drafts.`,
            });
        } finally {
          set((state) => ({ pending: state.pending - 1 }));
        }
      });
    }
    return {
      drafts: {},
      hydrated: false,
      pending: 0,
      error: null,
      previousAccountError: null,
      owner: null,
      generation: 0,
      unowned: 0,
      external: false,
      stored: {},
      readStartedAt: 0,
      readRevision: 0,
      hydrate() {
        if (hydration) return hydration;
        const mine = generation;
        const source = target;
        let readStartedAt = 0;
        // Reading waits for earlier writes, so re-entering an account never sees stale drafts.
        hydration = queue
          .then(() => {
            readStartedAt = Date.now();
            return source.read();
          })
          .then(
            async (drafts) => {
              if (mine !== generation) return;
              const recovery = unsaved.get(owner);
              if (recovery) {
                recovery.drafts = reconcileDrafts(recovery.ancestor, recovery.drafts, drafts);
                recovery.ancestor = drafts;
              }
              set({
                drafts: recovery?.drafts ?? drafts,
                hydrated: true,
                error: recovery?.error ?? null,
                external: false,
                stored: drafts,
                readStartedAt,
                readRevision: get().readRevision + 1,
              });
              unwatch?.();
              unwatch = source.subscribe?.(() => {
                if (mine === generation) set({ external: true });
              });
              if (owner === null || !storage.forUser || keptSeparate(owner)) return;
              try {
                const unowned = Object.keys(await storage.read()).length;
                if (mine === generation) set({ unowned });
              } catch {
                // An unreadable unowned bucket is left untouched, never reset.
              }
            },
            (error: unknown) => {
              if (mine !== generation) return;
              hydration = undefined;
              set({
                error: `Cannot recover local drafts: ${errorMessage(error).replace(/\.+$/, '')}. Editing is disabled; browsing is read-only.`,
              });
            },
          );
        return hydration;
      },
      activate(userId) {
        const next = userId === null ? null : String(userId);
        if (next === owner) return get().hydrate();
        if (get().error && unsaved.has(owner))
          set({
            previousAccountError: `The last edit of your previous account${owner ? ` (${owner})` : ''} was NOT stored: ${get().error} Sign back in to it and check your drafts.`,
          });
        owner = next;
        generation++;
        target = bucket(next);
        hydration = undefined;
        unwatch?.();
        unwatch = undefined;
        set({
          drafts: {},
          hydrated: false,
          error: null,
          owner: next,
          generation,
          unowned: 0,
          external: false,
          stored: {},
          readStartedAt: 0,
        });
        return get().hydrate();
      },
      async adopt() {
        const mine = generation;
        const account = owner;
        if (!get().hydrated || account === null || !storage.forUser)
          throw new Error('Sign in and finish draft recovery before adopting drafts');
        // Identical drafts are dropped from the unowned copy, so the account copy must be on disk.
        if (get().error) throw new Error('Fix draft storage (see the alert above) before adopting');
        await queue;
        const stale = { adopted: 0, left: get().unowned };
        if (mine !== generation) return stale;
        // A write queued before the click may have failed meanwhile.
        if (get().error) throw new Error('Fix draft storage (see the alert above) before adopting');
        const unowned = await storage.read();
        if (mine !== generation || get().error) return stale;
        const current = get().drafts;
        const moved: Drafts = {};
        const left: Drafts = {};
        let adopted = 0;
        for (const [hash, draft] of Object.entries(unowned)) {
          const existing = current[hash];
          if (!existing) {
            moved[hash] = draft;
            adopted++;
          } else if (JSON.stringify(existing) === JSON.stringify(draft)) adopted++;
          else left[hash] = draft; // The account already has its own draft: keep both.
        }
        const merged = Object.keys(moved).length ? { ...current, ...moved } : current;
        if (merged !== current) {
          set({ drafts: merged });
        }
        // Confirm even identical content through CAS: another tab may have changed the account.
        persist(merged);
        let result = stale;
        // Include edits queued during the read, and serialize cleanup with later edits/switches.
        // The snapshot must still be current and durably stored before deleting its source.
        queue = queue.then(async () => {
          if (mine !== generation || get().error || get().drafts !== merged) return;
          try {
            await storage.write(left);
          } catch (error) {
            if (mine !== generation) return;
            set({
              error: `Drafts were copied into your account, but the signed-out copy could not be cleared: ${errorMessage(error)}.`,
            });
            return;
          }
          if (mine !== generation || get().error) return;
          rememberSeparate(account);
          set({ unowned: 0 });
          result = { adopted, left: Object.keys(left).length };
        });
        await queue;
        return result;
      },
      dismissPreviousAccountError() {
        set({ previousAccountError: null });
      },
      keepSeparate() {
        if (owner === null) return;
        rememberSeparate(owner);
        set({ unowned: 0 });
      },
      edit(base, lang, text, author) {
        if (!get().hydrated) throw new Error('Drafts must finish recovery before editing');
        const draft = get().drafts[base.hash] ?? { base, next: base };
        const next: Tooltip = {
          ...draft.next,
          text: {
            ...draft.next.text,
            [lang]: {
              text,
              updatedAt: new Date().toISOString(),
              updatedBy: author,
              ...(lang !== 'en' && draft.next.text.en
                ? { sourceUpdatedAt: draft.next.text.en.updatedAt }
                : {}),
            },
          },
        };
        if (text === (draft.base.text[lang]?.text ?? '')) {
          if (draft.base.text[lang]) next.text[lang] = draft.base.text[lang];
          else delete next.text[lang];
        }
        const drafts: Drafts = { ...get().drafts, [base.hash]: { base: draft.base, next } };
        // Returning text to its base value should not create a metadata-only draft.
        // A changed edited string already proves inequality. Compare all fields
        // only on a return to the saved text, rather than serializing every
        // language and metadata field on each ordinary native keystroke.
        if (
          text === (draft.base.text[lang]?.text ?? '') &&
          JSON.stringify(next) === JSON.stringify(draft.base)
        ) {
          delete drafts[base.hash];
        }
        set({ drafts });
        persist(drafts);
      },
      updateDraft(base, update) {
        get().updateDrafts([{ base, update }]);
      },
      updateDrafts(updates) {
        if (!get().hydrated) throw new Error('Drafts must finish recovery before editing');
        const drafts: Drafts = { ...get().drafts };
        for (const { base, update } of updates) {
          const draft = drafts[base.hash] ?? { base, next: base };
          const next = update(structuredClone(draft.next));
          if (next.hash !== base.hash)
            throw new Error('A draft update cannot change the tooltip hash');
          drafts[base.hash] = { base: draft.base, next };
          if (JSON.stringify(next) === JSON.stringify(draft.base)) delete drafts[base.hash];
        }
        set({ drafts });
        persist(drafts);
      },
      discard(hash) {
        if (!get().hydrated) throw new Error('Drafts must finish recovery before discarding');
        const drafts: Drafts = { ...get().drafts };
        delete drafts[hash];
        set({ drafts });
        persist(drafts);
        for (const listener of discardListeners) listener(hash);
      },
      reloadFromStorage(merge) {
        const mine = generation;
        queue = queue.then(async () => {
          if (mine !== generation) return;
          try {
            const readStartedAt = Date.now();
            const theirs = await target.read();
            if (mine !== generation) return;
            const merged = merge(get().stored, get().drafts, theirs);
            set({
              drafts: merged,
              external: false,
              stored: theirs,
              readStartedAt,
              readRevision: get().readRevision + 1,
            });
            persist(merged);
          } catch (error) {
            if (mine === generation)
              set({
                error: `Cannot reload the drafts another tab stored: ${errorMessage(error).replace(/\.+$/, '')}. Keep this tab open and retry.`,
              });
          }
        });
        return settled();
      },
      keepMine() {
        const mine = generation;
        queue = queue.then(async () => {
          if (mine !== generation) return;
          try {
            // Reading refreshes the compare-and-set baseline, so this tab's write replaces theirs.
            const readStartedAt = Date.now();
            const theirs = await target.read();
            if (mine !== generation) return;
            set({
              external: false,
              stored: theirs,
              readStartedAt,
              readRevision: get().readRevision + 1,
            });
            persist(get().drafts);
          } catch (error) {
            if (mine === generation)
              set({
                error: `Cannot overwrite the drafts another tab stored: ${errorMessage(error).replace(/\.+$/, '')}. Keep this tab open and retry.`,
              });
          }
        });
        return settled();
      },
      onDiscard(listener) {
        discardListeners.add(listener);
        return () => void discardListeners.delete(listener);
      },
      onStored(listener) {
        storedListeners.add(listener);
        return () => void storedListeners.delete(listener);
      },
      retry() {
        if (!get().hydrated) throw new Error('Drafts must finish recovery before retrying storage');
        persist(get().drafts);
      },
      flush() {
        return queue;
      },
    };
  });
}

export const useDraftStore = createDraftStore(draftStorage);
