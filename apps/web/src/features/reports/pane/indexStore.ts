import { useEffect } from 'react';
import { create } from 'zustand';
import type { User } from '../../../services/api';
import { apiUrl } from '../../../services/api';
import { useAuthStore } from '../../../stores/auth';
import { useDataStore } from '../../../stores/data';
import { fetchReportsIndex } from './api';
import { useTooltipReports } from './reportsCache';

/** Revalidate on focus at most this often (the Worker also sends max-age=300). */
export const revalidateMs = 300_000;

interface IndexState {
  /** owner hash -> lang -> open (open or triaged) reports. Null until the first load. */
  open: Map<number, Record<string, number>> | null;
  etag: string | undefined;
  checkedAt: number;
  /** The session the index belongs to; a different account starts over. */
  owner: string | null;
  failed: boolean;
  loading: Promise<void> | null;
  load(owner: string, force?: boolean): Promise<void>;
  reset(): void;
}

function toMap(open: Record<string, Record<string, number>>) {
  const map = new Map<number, Record<string, number>>();
  for (const [hash, langs] of Object.entries(open)) map.set(Number(hash), langs);
  return map;
}

export const useReportsIndex = create<IndexState>((set, get) => ({
  open: null,
  etag: undefined,
  checkedAt: 0,
  owner: null,
  failed: false,
  loading: null,
  load(owner, force = false) {
    const state = get();
    if (state.owner !== owner)
      set({ open: null, etag: undefined, checkedAt: 0, owner, failed: false, loading: null });
    const current = get();
    if (current.loading) return current.loading;
    if (!force && current.open && Date.now() - current.checkedAt < revalidateMs)
      return Promise.resolve();
    const loading = fetchReportsIndex(current.open ? current.etag : undefined)
      .then((result) => {
        if (get().owner !== owner) return;
        if (result.unchanged) set({ checkedAt: Date.now(), failed: false });
        else
          set({
            open: toMap(result.index.open),
            etag: result.etag,
            checkedAt: Date.now(),
            failed: false,
          });
      })
      .catch(() => {
        // Failure = no markers, even after an earlier success (a 403 means the role is gone):
        // drop the old counts; the next focus or Retry tries again.
        if (get().owner === owner)
          set({ open: null, etag: undefined, failed: true, checkedAt: Date.now() });
      })
      .finally(() => {
        if (get().loading === loading) set({ loading: null });
      });
    set({ loading });
    return loading;
  },
  reset() {
    set({ open: null, etag: undefined, checkedAt: 0, owner: null, failed: false, loading: null });
  },
}));

/** Roles that may see reports (the Worker enforces it; translators only their languages). */
export function seesReports(user: User | null | undefined): user is User & { role: string } {
  return Boolean(apiUrl && user?.role);
}

/** The languages whose reports this user may read; null = every language. */
export function reportLanguages(user: User | null | undefined): readonly string[] | null {
  return user?.role === 'translator' ? (user.languages ?? []) : null;
}

/** Open reports for one tooltip + language, from the index (no request). Null: not known. */
export function openCount(
  open: Map<number, Record<string, number>> | null,
  hash: number,
  lang: string,
): number | null {
  if (!open) return null;
  return open.get(hash)?.[lang] ?? 0;
}

/** Tooltip + language pairs with open reports that this user may see, newest index order. */
export function openPairs(
  open: Map<number, Record<string, number>> | null,
  languages: readonly string[] | null,
): { hash: number; lang: string; n: number }[] {
  if (!open) return [];
  const pairs: { hash: number; lang: string; n: number }[] = [];
  for (const [hash, langs] of open)
    for (const [lang, n] of Object.entries(langs))
      if (n > 0 && (!languages || languages.includes(lang))) pairs.push({ hash, lang, n });
  return pairs;
}

/** A short fingerprint of the session token (never the token itself in a key). */
function fingerprint(token: string | null) {
  let hash = 0;
  for (const char of token ?? '') hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
const ownerKey = (user: User, token: string | null) =>
  `${user.id}:${user.role}:${(user.languages ?? []).join(',')}:${fingerprint(token)}`;

/**
 * Loads the index once per session, at idle after the editor data, for role holders only, and
 * revalidates on window focus at most every 5 minutes. Nothing about reports is requested on a
 * tooltip open.
 */
export function useReportsIndexLoader() {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const ready = useDataStore((state) => state.status === 'ready');
  const allowed = seesReports(user);
  const key = allowed ? ownerKey(user, token) : null;
  useEffect(() => {
    // Report bodies are private to the session that fetched them.
    useTooltipReports.getState().setOwner(key);
    if (!key) {
      if (useReportsIndex.getState().owner) useReportsIndex.getState().reset();
      return;
    }
    if (!ready) return;
    const load = () => void useReportsIndex.getState().load(key);
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if ('requestIdleCallback' in window) idle = window.requestIdleCallback(load, { timeout: 3000 });
    else timer = setTimeout(load, 0);
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle);
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [key, ready]);
}

/** After an action: revalidate now (a 304 if nothing moved the marker revision). */
export function refreshReportsIndex() {
  const { owner, load } = useReportsIndex.getState();
  if (owner) void load(owner, true);
}
