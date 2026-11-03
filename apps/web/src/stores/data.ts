import { create } from 'zustand';
import { loadGenerator } from '../services/generator';
import { loadBundle, type Bundle } from '../services/bundle';
import { errorMessage } from '../services/http';
import { applySavedOverlay } from './savedOverlay';

export type Catalog = Awaited<ReturnType<typeof loadGenerator>>;
export interface EditorData extends Catalog {
  bundle: Bundle;
}
interface DataState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: EditorData | null;
  error: string | null;
  load(): Promise<void>;
}

export const useDataStore = create<DataState>((set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  async load() {
    if (get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      const [catalog, bundle] = await Promise.all([loadGenerator(), loadBundle()]);
      set({ status: 'ready', data: { ...catalog, bundle: applySavedOverlay(bundle) } });
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) });
    }
  },
}));
