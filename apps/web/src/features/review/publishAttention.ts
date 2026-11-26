import { useEffect } from 'react';
import { create } from 'zustand';
import { apiUrl } from '../../services/api';
import {
  acknowledgePublish,
  getAccountPublishes,
  type AccountPublishes,
} from '../../services/publisher/api';
import { publisherEnabled } from '../../services/publisher/flag';
import { useAuthStore } from '../../stores/auth';

type Entry = AccountPublishes['entries'][number];

/** A whole publish whose outcome this account has not acknowledged: held rows, or nothing live. */
export const needsAttention = (entry: Entry) =>
  entry.held > 0 || entry.status === 'stale' || entry.status === 'rejected';

interface PublishAttention {
  userId: string | null;
  entries: Entry[];
  /** When this tab last read the account index (reads are throttled). */
  readAt: number;
  load(userId: string | null): Promise<void>;
  dismiss(): void;
}

/** Re-read at most this often while the tab keeps becoming visible. */
const rereadMs = 60_000;

/**
 * The account's publishes that need attention, from its publish index (any device, any browser).
 * Kept until acknowledged; with the acknowledgments unreadable every one shows (fail open).
 */
export const usePublishAttention = create<PublishAttention>((set, get) => ({
  userId: null,
  entries: [],
  readAt: 0,
  async load(userId) {
    if (userId === null || !publisherEnabled() || !apiUrl) {
      set({ userId: null, entries: [], readAt: 0 });
      return;
    }
    const now = Date.now();
    if (get().userId === userId && now - get().readAt < rereadMs) return;
    set({ userId, readAt: now, ...(get().userId === userId ? {} : { entries: [] }) });
    try {
      const { entries, acknowledged } = await getAccountPublishes();
      if (get().userId !== userId) return;
      const seen = new Set(acknowledged ?? []);
      set({ entries: entries.filter((entry) => needsAttention(entry) && !seen.has(entry.opId)) });
    } catch {
      // Unreadable now: the next visit (or visibility change) asks again.
      if (get().userId === userId) set({ readAt: 0 });
    }
  },
  dismiss() {
    const { entries } = get();
    set({ entries: [] });
    for (const { opId } of entries) void acknowledgePublish(opId).catch(() => undefined);
  },
}));

/** Reads the index for the signed-in account on arrival and when the tab becomes visible again. */
export function usePublishAttentionLoader() {
  const id = useAuthStore((state) => state.user?.id);
  const userId = id === undefined ? null : String(id);
  useEffect(() => {
    void usePublishAttention.getState().load(userId);
    const visible = () => {
      if (document.visibilityState === 'visible') void usePublishAttention.getState().load(userId);
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [userId]);
}

/** The shell's sentence for the publishes that need attention. */
export function attentionText(entries: readonly Entry[]): string {
  if (entries.length !== 1)
    return `Publish needs attention: ${entries.length} publishes did not fully go live.`;
  const [entry] = entries as [Entry];
  const rows = entry.rows + entry.globals;
  return entry.held > 0 && (entry.status === 'done' || entry.status === 'unchanged')
    ? `Publish needs attention: ${entry.held} of ${rows} changes were held back. The rest is live.`
    : `Publish needs attention: nothing from a publish of ${rows} ${rows === 1 ? 'change' : 'changes'} went live.`;
}
