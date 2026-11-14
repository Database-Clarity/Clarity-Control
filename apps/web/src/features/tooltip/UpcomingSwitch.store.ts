import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { BatchMember } from '@clarity/core/schedule';
import type { Drafts } from '../../services/draftStorage';

/** An open batch (draft, scheduled, or publishing) as schedule/index.json lists it. */
export interface OpenBatch {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'publishing';
  notBefore: string | null;
  revision: number;
  hashes: readonly number[];
}

/** The batch's future state over current saved, for every member. */
export interface UpcomingState {
  /** Drafts-shaped, so the preview, imports, and enhanced renders read it like drafts. */
  overlay: Drafts;
  /** Per member: non-translation fields current changed since the batch's base (stale, R14). */
  stale: Readonly<Record<number, readonly string[]>>;
  /** The member files themselves (base and proposed), for the Translations Upcoming rows. */
  members: Readonly<Record<number, BatchMember>>;
}

export type BatchLoad =
  | { state: 'loading'; revision: number }
  | { state: 'ready'; revision: number; upcoming: UpcomingState }
  | { state: 'failed'; revision: number; error: string };

export type PreviewSource = 'current' | 'upcoming';

export interface UpcomingStore {
  /** The editor-data head of the latest listing (null before the first one). */
  head: string | null;
  /** The latest listing failed (offline, signed out, server switch off); cleared by the next success. */
  listFailed: boolean;
  /** Hash -> its open batch (Q2: at most one). Only members appear. */
  memberOf: Readonly<Record<number, OpenBatch>>;
  /** Members and their future state, per batch id. */
  loads: Readonly<Record<string, BatchLoad>>;
  /** Per tab (this page's memory), never synced or stored: reload starts on Current. */
  source: PreviewSource;
  setSource(source: PreviewSource): void;
}

let store: UseBoundStore<StoreApi<UpcomingStore>> | undefined;

/**
 * Created on first use, never at import: with the build switch OFF nothing calls this, so the
 * store (and everything that fills it) is dropped from the bundle.
 */
export function upcomingStore() {
  store ??= create<UpcomingStore>((set) => ({
    head: null,
    listFailed: false,
    memberOf: {},
    loads: {},
    source: 'current',
    setSource: (source) => set({ source }),
  }));
  return store;
}
