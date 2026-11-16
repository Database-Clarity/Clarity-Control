import { create } from 'zustand';
import { createNumberStore, type NumberStore } from './state';

const empty = createNumberStore();
const useDocuments = create<{ stores: Record<string, NumberStore> }>(() => ({ stores: {} }));
export function registerNumbers(hash: number, lang: string, store: NumberStore) {
  const key = `${hash}:${lang}`;
  useDocuments.setState((state) => ({ stores: { ...state.stores, [key]: store } }));
  return () =>
    useDocuments.setState((state) => {
      if (state.stores[key] !== store) return state;
      const stores = { ...state.stores };
      delete stores[key];
      return { stores };
    });
}
export const useNumberDocument = (hash: number, lang: string) =>
  useDocuments((state) => state.stores[`${hash}:${lang}`] ?? empty);
