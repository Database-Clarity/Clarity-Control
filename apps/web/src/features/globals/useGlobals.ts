import { useMemo } from 'react';
import { globalDefinitions, globalUsageEntries } from './model';
import type { EditorData } from '../../stores/data';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

export function useGlobals() {
  const data = useDataStore((state) => state.data);
  const drafts = useDraftStore((state) => state.drafts);
  return useMemo(
    () =>
      globalUsageEntries({
        ...data?.bundle.tooltips,
        ...Object.fromEntries(Object.entries(drafts).map(([hash, draft]) => [hash, draft.next])),
      }),
    [data, drafts],
  );
}

/** Subscribe only to aggregate definitions, so ordinary tooltip typing cannot rebuild the finder. */
export function useGlobalDefinitions(override?: EditorData) {
  const stored = useDataStore((state) => state.data);
  const data = override ?? stored;
  const variables = useDraftStore((state) => state.drafts[2]?.next);
  const titles = useDraftStore((state) => state.drafts[3]?.next);
  const exports = useDraftStore((state) => state.drafts[1]?.next);
  return useMemo(
    () =>
      globalDefinitions({
        ...data?.bundle.tooltips,
        ...(variables && { 2: variables }),
        ...(titles && { 3: titles }),
        ...(exports && { 1: exports }),
      }),
    [data, variables, titles, exports],
  );
}

/** Finder lists change only when declaration identity changes; values update in hover leaves. */
export function useGlobalCatalog(data: EditorData) {
  const select = useMemo(() => {
    let previous: ReturnType<typeof globalDefinitions> = [];
    let signature = '';
    let inputs: unknown[] = [];
    return (state: ReturnType<typeof useDraftStore.getState>) => {
      const next = [state.drafts[1]?.next, state.drafts[2]?.next, state.drafts[3]?.next];
      if (next.every((value, index) => value === inputs[index]) && inputs.length) return previous;
      inputs = next;
      const definitions = globalDefinitions({
        1: state.drafts[1]?.next ?? data.bundle.tooltips[1],
        2: state.drafts[2]?.next ?? data.bundle.tooltips[2],
        3: state.drafts[3]?.next ?? data.bundle.tooltips[3],
      });
      const key = JSON.stringify(
        definitions.map(({ kind, name, definitions }) => [kind, name, Object.keys(definitions)]),
      );
      if (key !== signature) {
        signature = key;
        previous = definitions;
      }
      return previous;
    };
  }, [data]);
  return useDraftStore(select);
}

export function useGlobalHover(entry?: ReturnType<typeof globalDefinitions>[number]) {
  const draft = useDraftStore((state) => (entry ? state.drafts[entry.hash]?.next : undefined));
  return useMemo(() => {
    if (!entry) return undefined;
    const current = draft
      ? globalDefinitions({ [draft.hash]: draft }).find(({ name }) => name === entry.name)
      : entry;
    return Object.values(current?.definitions ?? {}).join('\n\n');
  }, [draft, entry]);
}
