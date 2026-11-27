import { useEffect } from 'react';
import { create } from 'zustand';
import { apiUrl } from '../../services/api';
import {
  acknowledgePublish,
  getAccountPublishes,
  getPublishOutcome,
  type AccountPublishes,
} from '../../services/publisher/api';
import { publisherEnabled } from '../../services/publisher/flag';
import { sessionToken } from '../../services/session';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { canPushLive } from '../auth/permissions';

type Entry = AccountPublishes['entries'][number];
/** One row a publish did not take live, named for the shell (tooltip or shared definition). */
export interface NotLive {
  hash?: number;
  name: string;
  reason: string;
}
export type AttentionEntry = Entry & { notLive?: NotLive[] };

/** A whole publish whose outcome this account has not acknowledged: held rows, or nothing live. */
export const needsAttention = (entry: Entry) =>
  entry.held > 0 || entry.status === 'stale' || entry.status === 'rejected';

interface PublishAttention {
  /** The settled account and session the entries were read with. */
  key: string | null;
  entries: AttentionEntry[];
  /** When this tab last read the account index (reads are throttled). */
  readAt: number;
  load(): Promise<void>;
  dismiss(): void;
}

/** Only the latest read may adopt its answers (a role can change under the same session). */
let reads = 0;
/** Re-read at most this often while the tab keeps becoming visible. */
const rereadMs = 60_000;
/** Outcome details are read for at most this many publishes per visit. */
const detailed = 5;

/** The signed-in account and its session, once both are settled; null while signing in or out. */
function settledKey(): string | null {
  const { user, token, loading } = useAuthStore.getState();
  if (loading || !user || !token) return null;
  try {
    return sessionToken() === token ? `${user.id}|${token}` : null;
  } catch {
    return null;
  }
}

/** The names Review shows: generator name, custom name, or the hash. */
function rowName(hash: number): string {
  const data = useDataStore.getState().data;
  return data?.items[hash]?.name ?? data?.bundle.tooltips[hash]?.custom?.name ?? `Tooltip ${hash}`;
}

/**
 * The account's publishes that need attention, from its publish index (any device, any browser),
 * with what each left out and why when the account may read publish status (editors and
 * maintainers; a role-changed account keeps the counts). Kept until acknowledged; with the
 * acknowledgments unreadable every one shows (fail open). Every answer is kept only for the
 * account and session that asked, so an account switch never shows another account's outcome.
 */
export const usePublishAttention = create<PublishAttention>((set, get) => ({
  key: null,
  entries: [],
  readAt: 0,
  async load() {
    const key = settledKey();
    if (key === null || !publisherEnabled() || !apiUrl) {
      set({ key: null, entries: [], readAt: 0 });
      return;
    }
    const now = Date.now();
    if (get().key === key && now - get().readAt < rereadMs) return;
    set({ key, readAt: now, ...(get().key === key ? {} : { entries: [] }) });
    const read = ++reads;
    const current = () => read === reads && get().key === key && settledKey() === key;
    try {
      const { entries, acknowledged } = await getAccountPublishes();
      if (!current()) return;
      const seen = new Set(acknowledged ?? []);
      const open: AttentionEntry[] = entries.filter(
        (entry) => needsAttention(entry) && !seen.has(entry.opId),
      );
      set({ entries: open });
      if (!canPushLive(useAuthStore.getState().user)) return;
      const named = await Promise.all(
        open.slice(-detailed).map(async (entry) => {
          try {
            const { held, globals } = await getPublishOutcome(entry.opId);
            return {
              ...entry,
              notLive: [
                ...held.map(({ hash, reason }) => ({ hash, name: rowName(hash), reason })),
                ...globals.map(({ id, error }) => ({ name: id, reason: error })),
              ],
            };
          } catch {
            return entry;
          }
        }),
      );
      // Details only while the account may still read publish status.
      if (!current() || !canPushLive(useAuthStore.getState().user)) return;
      const byId = new Map(named.map((entry) => [entry.opId, entry]));
      set({ entries: get().entries.map((entry) => byId.get(entry.opId) ?? entry) });
    } catch {
      // Unreadable now: the next visit (or visibility change) asks again.
      if (get().key === key) set({ readAt: 0 });
    }
  },
  dismiss() {
    const { entries, key } = get();
    set({ entries: [] });
    if (key !== null && settledKey() === key)
      for (const { opId } of entries) void acknowledgePublish(opId).catch(() => undefined);
  },
}));

/**
 * Reads the index for the signed-in account on arrival, after any account or session change has
 * settled, and when the tab becomes visible again. While the sign-in changes, nothing shows.
 */
export function usePublishAttentionLoader() {
  // Names come from the editor data, which can arrive after the notice: re-render with it.
  useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const loading = useAuthStore((state) => state.loading);
  useEffect(() => {
    void usePublishAttention.getState().load();
    const visible = () => {
      if (document.visibilityState === 'visible') void usePublishAttention.getState().load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [user, token, loading]);
}

const list = new Intl.ListFormat('en');
const reasonOf = (reason: string) => reason.replace(/[.]$/, '');

/** The shell's sentence for the publishes that need attention. */
export function attentionText(entries: readonly AttentionEntry[]): string {
  if (entries.length !== 1)
    return `Publish needs attention: ${entries.length} publishes did not fully go live.`;
  const [entry] = entries as [AttentionEntry];
  const rows = entry.rows + entry.globals;
  const partly = entry.held > 0 && (entry.status === 'done' || entry.status === 'unchanged');
  const named = entry.notLive?.length
    ? ` Not published: ${list.format(
        entry.notLive
          .slice(0, 3)
          .map(
            ({ hash, name, reason }) =>
              `${hash === undefined ? name : rowName(hash)} (${reasonOf(reason)})`,
          ),
      )}${entry.notLive.length > 3 ? ` and ${entry.notLive.length - 3} more` : ''}.`
    : '';
  return partly
    ? `Publish needs attention: ${entry.held} of ${rows} changes were held back.${named} The rest is live.`
    : `Publish needs attention: nothing from a publish of ${rows} ${rows === 1 ? 'change' : 'changes'} went live.${named}`;
}

/** Where "Review changes" goes: the first held tooltip, else the Review list. */
export function attentionTarget(entries: readonly AttentionEntry[]): string {
  const hash = entries.flatMap(({ notLive = [] }) => notLive).find((row) => row.hash)?.hash;
  return hash === undefined ? '/review' : `/review?hash=${hash}`;
}
