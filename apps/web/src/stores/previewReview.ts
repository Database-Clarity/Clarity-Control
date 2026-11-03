import { create } from 'zustand';
import { z } from 'zod';
import { stableStringify, type Tooltip } from '@clarity/core';
import type { Drafts } from '../services/draftStorage';
import { canonicalHash, tooltipFor } from '../features/navigation/catalog';
import { useDataStore } from './data';
import { useDraftStore } from './drafts';

/**
 * Which edited tooltips the user has not yet seen rendered in the preview.
 *
 * Each tooltip variant has a change counter (`dirty`) and a seen counter (`reviewed`). Any change to
 * its text in any language, or to its Compendium link, bumps `dirty`. A visible preview that has
 * rendered the current text at revision N calls `acknowledge(variant, N)`. The item is unreviewed
 * while `dirty > reviewed`, so changing and reverting still counts until a preview is shown, and a
 * later edit re-arms it. Showing the selected language once is enough (owner decision 7B).
 *
 * Only a page that registers a preview host (the desktop editor, whose preview column can be
 * collapsed) takes part: without one nothing is recorded and nothing is blocked.
 *
 * The store watches the draft store itself, not a component, so a change is recorded even when the
 * page that made it unmounts in the same moment. Unreviewed items are saved on this device, per
 * account, and come back after a reload (owner decision 1B). Saving a draft keeps the obligation;
 * discarding it clears it.
 */
export interface ReviewEntry {
  /** The canonical item the variant belongs to. */
  canonical: number;
  dirty: number;
  reviewed: number;
}

const entrySchema = z.object({
  canonical: z.number().int().nonnegative(),
  dirty: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
});

export const reviewKey = (scope: string) => `clarity-preview-review:v1:${scope}`;

/** What a reader can see in the preview: text per language and the Compendium link, nothing else. */
export function reviewSignature(tooltip: Tooltip): string {
  const text: Record<string, string> = {};
  for (const [lang, value] of Object.entries(tooltip.text)) text[lang] = value?.text ?? '';
  return stableStringify({ text, compendium: tooltip.compendium ?? null });
}

export function changedVariants(
  before: Drafts,
  after: Drafts,
  baseOf: (hash: number) => Tooltip | undefined,
): number[] {
  const changed: number[] = [];
  for (const [key, draft] of Object.entries(after)) {
    const was = before[key] ? before[key].next : draft.base;
    if (reviewSignature(draft.next) !== reviewSignature(was)) changed.push(Number(key));
  }
  for (const [key, draft] of Object.entries(before)) {
    if (after[key]) continue;
    // The draft went away: reverted to base, discarded, or saved. What the reader sees changes
    // only when the text it falls back to differs from what the draft showed.
    const fallback = baseOf(Number(key)) ?? draft.base;
    if (reviewSignature(fallback) !== reviewSignature(draft.next)) changed.push(Number(key));
  }
  return changed;
}

export interface PreviewReviewDeps {
  drafts: typeof useDraftStore;
  canonicalOf(hash: number): number;
  baseOf(hash: number): Tooltip | undefined;
  /** The guard exists only where the preview can be collapsed; phones always show it. */
  desktop(): boolean;
  storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}

export interface PreviewHost {
  /** Expands and focuses the preview column. */
  show(): void;
}

export interface PreviewReviewState {
  scope: string | null;
  entries: Record<number, ReviewEntry>;
  /** Bumped by every change to `entries`, so a history operation can tell nothing moved under it. */
  epoch: number;
  /** The canonical item the prompt is about, or null. Set when a gesture is refused before navigating. */
  prompt: number | null;
  host: PreviewHost | null;
  /** Unreviewed variants of this canonical item. */
  unreviewed(canonical: number): number[];
  /** True when leaving `from` for `to` (pathnames) must show the prompt first. */
  leaveBlocked(from: string, to: string): boolean;
  /**
   * For callers that act before navigating (wheel and arrow stepping): false means refused and the
   * prompt is now showing.
   */
  requestLeave(from: string, to: string): boolean;
  /** A preview that is visible has rendered `variant` at `revision`. Older renders never clear newer edits. */
  acknowledge(variant: number, revision: number): void;
  clear(variant: number): void;
  dismissPrompt(): void;
  registerHost(host: PreviewHost): () => void;
  /** Starts watching the drafts. Returns the stop function. */
  start(): () => void;
}

function itemPath(pathname: string): number | undefined {
  const match = /^\/t\/(0|[1-9]\d*)$/.exec(pathname);
  return match ? Number(match[1]) : undefined;
}

export function createPreviewReviewStore(deps: PreviewReviewDeps) {
  function read(scope: string): Record<number, ReviewEntry> {
    const entries: Record<number, ReviewEntry> = {};
    try {
      const raw = deps.storage()?.getItem(reviewKey(scope));
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return entries;
      for (const [key, value] of Object.entries(parsed)) {
        const result = entrySchema.safeParse(value);
        if (result.success && /^\d+$/.test(key) && result.data.dirty > result.data.reviewed)
          entries[Number(key)] = result.data;
      }
    } catch {
      // An unreadable copy starts empty; drafts themselves are untouched.
    }
    return entries;
  }
  function write(scope: string, entries: Record<number, ReviewEntry>) {
    const pending = Object.fromEntries(
      Object.entries(entries).filter(([, entry]) => entry.dirty > entry.reviewed),
    );
    try {
      const storage = deps.storage();
      if (Object.keys(pending).length) storage?.setItem(reviewKey(scope), JSON.stringify(pending));
      else storage?.removeItem(reviewKey(scope));
    } catch {
      // Best effort: without storage the obligation lasts until the tab closes.
    }
  }

  return create<PreviewReviewState>((set, get) => {
    function commit(entries: Record<number, ReviewEntry>) {
      const { scope, epoch } = get();
      // Before the drafts have loaded there is no account to attribute a change to.
      if (scope === null) return;
      set({ entries, epoch: epoch + 1 });
      write(scope, entries);
    }
    const unreviewed = (canonical: number) =>
      Object.entries(get().entries)
        .filter(([, entry]) => entry.canonical === canonical && entry.dirty > entry.reviewed)
        .map(([variant]) => Number(variant));
    function leaveBlocked(from: string, to: string) {
      // Without a preview column that can show the change there is nothing to ask for.
      if (!get().host || !deps.desktop()) return false;
      const fromHash = itemPath(from);
      if (fromHash === undefined) return false;
      const item = deps.canonicalOf(fromHash);
      const toHash = itemPath(to);
      if (toHash !== undefined && deps.canonicalOf(toHash) === item) return false;
      // Opening Settings returns to the same page; it is not leaving.
      if (to === '/settings') return false;
      return unreviewed(item).length > 0;
    }
    return {
      scope: null,
      entries: {},
      epoch: 0,
      prompt: null,
      host: null,
      unreviewed,
      leaveBlocked,
      requestLeave(from, to) {
        if (!leaveBlocked(from, to)) return true;
        set({ prompt: deps.canonicalOf(itemPath(from) ?? 0) });
        return false;
      },
      acknowledge(variant, revision) {
        const entry = get().entries[variant];
        // A render cannot have shown a revision that does not exist yet.
        if (!entry || revision <= entry.reviewed || revision > entry.dirty) return;
        commit({ ...get().entries, [variant]: { ...entry, reviewed: revision } });
      },
      clear(variant) {
        const entries = { ...get().entries };
        if (!entries[variant]) return;
        delete entries[variant];
        commit(entries);
      },
      dismissPrompt() {
        if (get().prompt !== null) set({ prompt: null });
      },
      registerHost(host) {
        set({ host });
        return () => {
          if (get().host === host) set({ host: null });
        };
      },
      start() {
        let baseline: Drafts | null = null;
        let scope: string | null = null;
        const observe = (state: ReturnType<typeof deps.drafts.getState>) => {
          if (!state.hydrated) {
            baseline = null;
            scope = null;
            set({ scope: null, entries: {}, prompt: null });
            return;
          }
          const owner = state.owner ?? 'anonymous';
          if (baseline === null || owner !== scope) {
            // Loading (or switching account) is not an edit: take the drafts as they are.
            scope = owner;
            baseline = state.drafts;
            set({ scope: owner, entries: read(owner), prompt: null, epoch: get().epoch + 1 });
            return;
          }
          if (state.drafts === baseline) return;
          const before = baseline;
          baseline = state.drafts;
          // Changes made where no collapsible preview exists (phone, or before a page registers one)
          // are rendered as they happen: there is nothing to review later.
          if (!get().host) return;
          const changed = changedVariants(before, state.drafts, deps.baseOf);
          if (!changed.length) return;
          const entries = { ...get().entries };
          for (const variant of changed) {
            const entry = entries[variant];
            entries[variant] = {
              canonical: deps.canonicalOf(variant),
              dirty: (entry?.dirty ?? 0) + 1,
              reviewed: entry?.reviewed ?? 0,
            };
          }
          commit(entries);
        };
        observe(deps.drafts.getState());
        const stopDrafts = deps.drafts.subscribe(observe);
        const stopDiscard = deps.drafts.getState().onDiscard((hash) => get().clear(hash));
        return () => {
          stopDrafts();
          stopDiscard();
        };
      },
    };
  });
}

function currentData() {
  return useDataStore.getState().data ?? undefined;
}

export const usePreviewReviewStore = createPreviewReviewStore({
  drafts: useDraftStore,
  canonicalOf(hash) {
    const data = currentData();
    return data ? canonicalHash(hash, data) : hash;
  },
  baseOf(hash) {
    const data = currentData();
    return data ? tooltipFor(hash, data) : undefined;
  },
  desktop() {
    return (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      !window.matchMedia('(max-width: 700px)').matches
    );
  },
  storage() {
    try {
      return localStorage;
    } catch {
      return undefined;
    }
  },
});
