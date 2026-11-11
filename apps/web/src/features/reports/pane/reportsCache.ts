import { create } from 'zustand';
import { errorMessage } from '../../../services/http';
import { fetchTooltipReports, type PaneReport } from './api';

export interface ReportsEntry {
  reports: PaneReport[] | null;
  loading: boolean;
  error: string | null;
  /** The index's open count when this list was fetched (null: unknown). */
  indexCount?: number | null;
}

interface CacheState {
  /** `${hash}:${lang}` -> reports, kept for this session (the pane fetches only on open). */
  entries: Record<string, ReportsEntry>;
  /** The session the entries belong to (account, role, languages, token); another one starts over. */
  owner: string | null;
  /** Bumped on every clear: a response for an older generation is dropped. */
  generation: number;
  setOwner(owner: string | null): void;
  load(hash: number, lang: string, force?: boolean, indexCount?: number | null): Promise<void>;
  /** Replace one report after an action (the Worker answered with its new status and version). */
  update(hash: number, lang: string, id: string, patch: Partial<PaneReport>): void;
  remove(hash: number, lang: string, id: string): void;
  clear(): void;
}

export const reportsKey = (hash: number, lang: string) => `${hash}:${lang}`;
const inflight = new Map<string, Promise<void>>();

export const useTooltipReports = create<CacheState>((set, get) => ({
  entries: {},
  owner: null,
  generation: 0,
  setOwner(owner) {
    if (get().owner === owner) return;
    get().clear();
    set({ owner });
  },
  load(hash, lang, force = false, indexCount = null) {
    const key = reportsKey(hash, lang);
    const generation = get().generation;
    const current = () => get().generation === generation;
    const running = inflight.get(key);
    if (running) return running;
    const entry = get().entries[key];
    if (entry?.reports && !force) return Promise.resolve();
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { reports: entry?.reports ?? null, loading: true, error: null, indexCount },
      },
    }));
    const promise = fetchTooltipReports(hash, lang)
      .then((reports) => {
        // Signed out, another account, or cleared meanwhile: this body is not for this session.
        if (!current()) return;
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { reports, loading: false, error: null, indexCount },
          },
        }));
      })
      .catch((error: unknown) => {
        if (!current()) return;
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: {
              reports: state.entries[key]?.reports ?? null,
              loading: false,
              error: errorMessage(error),
              indexCount,
            },
          },
        }));
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  },
  update(hash, lang, id, patch) {
    const key = reportsKey(hash, lang);
    set((state) => {
      const entry = state.entries[key];
      if (!entry?.reports) return state;
      return {
        entries: {
          ...state.entries,
          [key]: {
            ...entry,
            reports: entry.reports.map((report) =>
              report.id === id ? { ...report, ...patch } : report,
            ),
          },
        },
      };
    });
  },
  remove(hash, lang, id) {
    const key = reportsKey(hash, lang);
    set((state) => {
      const entry = state.entries[key];
      if (!entry?.reports) return state;
      return {
        entries: {
          ...state.entries,
          [key]: { ...entry, reports: entry.reports.filter((report) => report.id !== id) },
        },
      };
    });
  },
  clear() {
    inflight.clear();
    set((state) => ({ entries: {}, generation: state.generation + 1 }));
  },
}));

export const activeStatuses = ['open', 'triaged'] as const;
export const isActive = (report: Pick<PaneReport, 'status'>) =>
  report.status === 'open' || report.status === 'triaged';
