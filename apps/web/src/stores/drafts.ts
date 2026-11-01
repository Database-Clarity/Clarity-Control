import { create } from 'zustand';
import { type Lang, type Tooltip } from '@clarity/core';
import { draftStorage, type Drafts, type DraftStorage } from '../services/draftStorage';
import { errorMessage } from '../services/http';

interface DraftState {
  drafts: Drafts;
  hydrated: boolean;
  pending: number;
  error: string | null;
  hydrate(): Promise<void>;
  edit(base: Tooltip, lang: Lang, text: string, author: string): void;
  updateDraft(base: Tooltip, update: (tooltip: Tooltip) => Tooltip): void;
  updateDrafts(updates: { base: Tooltip; update: (tooltip: Tooltip) => Tooltip }[]): void;
  discard(hash: number): void;
  retry(): void;
  flush(): Promise<void>;
}

export function createDraftStore(storage: DraftStorage) {
  let queue = Promise.resolve();
  let hydration: Promise<void> | undefined;
  return create<DraftState>((set, get) => {
    function persist(drafts: Drafts) {
      set((state) => ({ pending: state.pending + 1 }));
      queue = queue.then(async () => {
        try {
          await storage.write(drafts);
          set({ error: null });
        } catch (error) {
          set({
            error: `Drafts are NOT safely stored: ${errorMessage(error)}. Keep this tab open and retry.`,
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
      hydrate() {
        hydration ??= storage.read().then(
          (drafts) => {
            set({ drafts, hydrated: true, error: null });
          },
          (error: unknown) => {
            hydration = undefined;
            set({
              error: `Cannot recover local drafts: ${errorMessage(error)}. Editing is disabled.`,
            });
          },
        );
        return hydration;
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
