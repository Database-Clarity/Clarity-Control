// The data site's state for the export pages: status (the preview snapshot), manifest (each URL's
// last build), and notices. Read when an export page opens and again when the window comes back
// into view; a newer build is offered, never swapped in under the person (spec section 3).
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { errorMessage } from '../../services/http';
import { PreviewClient } from './previewClient';
import {
  loadManifest,
  loadNotices,
  loadStatus,
  type BuildStatus,
  type SiteManifest,
  type SiteNotice,
} from './site';

interface SiteState {
  status: BuildStatus | null;
  manifest: SiteManifest | null;
  notices: SiteNotice[];
  loading: boolean;
  error: string | null;
  loadedAt: number;
  refresh(): Promise<void>;
}

let request = 0;
export const useSiteStore = create<SiteState>((set) => ({
  status: null,
  manifest: null,
  notices: [],
  loading: false,
  error: null,
  loadedAt: 0,
  async refresh() {
    const id = ++request;
    set({ loading: true });
    try {
      const [status, manifest, notices] = await Promise.all([
        loadStatus(),
        loadManifest().catch(() => null),
        loadNotices(),
      ]);
      if (id === request)
        set({ status, manifest, notices, loading: false, error: null, loadedAt: Date.now() });
    } catch (error) {
      if (id === request) set({ loading: false, error: errorMessage(error) });
    }
  },
}));

/** Loads the site state once per page and again when the window is shown after a while. */
export function useSiteRefresh() {
  const refresh = useSiteStore((state) => state.refresh);
  useEffect(() => {
    if (!useSiteStore.getState().loadedAt) void refresh();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - useSiteStore.getState().loadedAt > 30_000) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
}

export type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; client: PreviewClient }
  | { kind: 'error'; message: string; mismatch: boolean };

/**
 * One preview (two workers) per page, on the snapshot the page first read. `adopt` moves it to
 * the newest status (the "newer build" notice); until then the preview stays on its snapshot.
 */
export function usePreview(enabled = true) {
  const status = useSiteStore((state) => state.status);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const current = buildId ?? status?.buildId ?? null;
  const snapshot = useSnapshotStatus(current, status);
  useEffect(() => {
    if (!enabled || !snapshot) return;
    const client = new PreviewClient(snapshot);
    setState({ kind: 'loading' });
    let live = true;
    client.ready.then(
      () => live && setState({ kind: 'ready', client }),
      (error: Error & { mismatch?: boolean }) =>
        live && setState({ kind: 'error', message: error.message, mismatch: !!error.mismatch }),
    );
    return () => {
      live = false;
      client.dispose();
    };
  }, [snapshot, enabled]);
  useEffect(() => {
    if (buildId === null && status) setBuildId(status.buildId);
  }, [buildId, status]);
  return {
    state,
    buildId: current,
    newer: status && current && status.buildId !== current ? status : null,
    adopt: () => status && setBuildId(status.buildId),
  };
}

/** The status object of the snapshot in use (kept while a newer one is only offered). */
function useSnapshotStatus(buildId: string | null, latest: BuildStatus | null) {
  const [kept, setKept] = useState<BuildStatus | null>(null);
  useEffect(() => {
    if (latest && latest.buildId === buildId && kept?.buildId !== buildId) setKept(latest);
  }, [buildId, latest, kept]);
  return kept?.buildId === buildId ? kept : null;
}
