import { create } from 'zustand';
import { type Lang, type Tooltip } from '@clarity/core';
import { draftStorage, type Drafts, type DraftStorage } from '../services/draftStorage';
import { errorMessage } from '../services/http';

export interface AdoptionResult {
  adopted: number;
  left: number;
}
interface DraftState {
  drafts: Drafts;
  hydrated: boolean;
  pending: number;
  error: string | null;
  /** Account whose drafts are loaded; null = signed out (the unowned bucket). */
  owner: string | null;
  /** Bumped on every account switch, so long operations can tell the drafts they started with. */
  generation: number;
  /** Unowned drafts waiting for an adopt / keep-separate decision (only while signed in). */
  unowned: number;
  hydrate(): Promise<void>;
  /** Switches to the drafts of this account (null = signed out). Same account: no-op. */
  activate(userId: string | number | null): Promise<void>;
  /** Moves unowned drafts into the signed-in account. Never overwrites or drops a draft. */
  adopt(): Promise<AdoptionResult>;
  keepSeparate(): void;
  edit(base: Tooltip, lang: Lang, text: string, author: string): void;
  updateDraft(base: Tooltip, update: (tooltip: Tooltip) => Tooltip): void;
  updateDrafts(updates: { base: Tooltip; update: (tooltip: Tooltip) => Tooltip }[]): void;
  discard(hash: number): void;
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
  return create<DraftState>((set, get) => {
    function persist(drafts: Drafts) {
      // Bind the bucket now: a later account switch must never redirect this write.
      const destination = target;
      set((state) => ({ pending: state.pending + 1 }));
      queue = queue.then(async () => {
        try {
          await destination.write(drafts);
          set({ error: null });
        } catch (error) {
          set({
            error:
              destination === target
                ? `Drafts are NOT safely stored: ${errorMessage(error)}. Keep this tab open and retry.`
                : `The last edit of your previous account was NOT stored: ${errorMessage(error)}. Sign back in to it and check your drafts.`,
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
      owner: null,
      generation: 0,
      unowned: 0,
      hydrate() {
        if (hydration) return hydration;
        const mine = generation;
        const source = target;
        // Reading waits for earlier writes, so re-entering an account never sees stale drafts.
        hydration = queue
          .then(() => source.read())
          .then(
            async (drafts) => {
              if (mine !== generation) return;
              set({ drafts, hydrated: true, error: null });
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
                error: `Cannot recover local drafts: ${errorMessage(error)}. Editing is disabled.`,
              });
            },
          );
        return hydration;
      },
      activate(userId) {
        const next = userId === null ? null : String(userId);
        if (next === owner) return get().hydrate();
        owner = next;
        generation++;
        target = bucket(next);
        hydration = undefined;
        set({ drafts: {}, hydrated: false, error: null, owner: next, generation, unowned: 0 });
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
        const unowned = await storage.read();
        if (mine !== generation) return stale;
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
        if (Object.keys(moved).length) {
          const merged: Drafts = { ...current, ...moved };
          set({ drafts: merged });
          persist(merged);
          await queue;
          // Copy first, delete second: a failure here can only duplicate, never lose.
          if (mine !== generation || get().error) return stale;
        }
        try {
          await storage.write(left);
        } catch (error) {
          set({
            error: `Drafts were copied into your account, but the signed-out copy could not be cleared: ${errorMessage(error)}.`,
          });
          return stale;
        }
        rememberSeparate(account);
        set({ unowned: 0 });
        return { adopted, left: Object.keys(left).length };
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
        if (JSON.stringify(next) === JSON.stringify(draft.base)) {
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
