import { create } from 'zustand';
import type { CompendiumData } from '@clarity/core';
import {
  compendiumRefreshStatus,
  isRequestedRun,
  loadCompendium,
  requestCompendiumRefresh,
} from '../../services/compendium';
import { errorMessage } from '../../services/http';

interface CompendiumState {
  data: CompendiumData | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  refreshMessage: string | null;
  load(force?: boolean): Promise<void>;
  refresh(): Promise<void>;
}
export const useCompendiumStore = create<CompendiumState>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  refreshing: false,
  refreshMessage: null,
  async load(force = false) {
    if (get().loading || (!force && get().data)) return;
    set({ loading: true, error: null });
    try {
      set({ data: await loadCompendium(force) });
    } catch (error) {
      set({ error: `Cannot load Compendium: ${errorMessage(error)}` });
    } finally {
      set({ loading: false });
    }
  },
  async refresh() {
    if (get().refreshing) return;
    set({ refreshing: true, error: null, refreshMessage: 'Queuing Compendium refresh...' });
    const previous = get().data?.fetchedAt;
    try {
      const request = await requestCompendiumRefresh();
      const deadline = Date.now() + 15 * 60_000;
      let nextDataPoll = 0;
      while (Date.now() < deadline) {
        const run = await compendiumRefreshStatus();
        if (Date.now() >= nextDataPoll) {
          set({ data: await loadCompendium(true) });
          nextDataPoll = Date.now() + 60_000;
        }
        if (run && isRequestedRun(request, run)) {
          if (run.status === 'completed') {
            if (run.conclusion !== 'success')
              throw new Error(`Refresh ${run.conclusion ?? 'failed'}; see ${run.html_url}`);
            const data = await loadCompendium(true);
            set({
              data,
              refreshMessage:
                data.fetchedAt === previous
                  ? 'Compendium is up to date; the successful refresh found no content changes.'
                  : 'Compendium refreshed. Current cells and differences are updated.',
            });
            return;
          }
          set({
            refreshMessage:
              run.status === 'in_progress'
                ? 'Fetching and parsing Compendium...'
                : 'Compendium refresh queued...',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      throw new Error(
        'Refresh is still queued/running after 15 minutes. Check the Compendium repository Actions page before retrying.',
      );
    } catch (error) {
      set({ error: `Compendium refresh failed: ${errorMessage(error)}`, refreshMessage: null });
    } finally {
      set({ refreshing: false });
    }
  },
}));
