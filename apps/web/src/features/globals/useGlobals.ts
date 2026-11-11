import { useMemo } from 'react';
import { globalDefinitions, createGlobalUsageProjection } from './model';
import type { EditorData } from '../../stores/data';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

const projections = new WeakMap<object, ReturnType<typeof createGlobalUsageProjection>>();
const noTooltips = {};
export function useGlobals() {
  const tooltips = useDataStore((state) => state.data?.bundle.tooltips ?? noTooltips);
  const drafts = useDraftStore((state) => state.drafts);
  return useMemo(() => {
    let project = projections.get(tooltips);
    if (!project) {
      project = createGlobalUsageProjection(tooltips);
      projections.set(tooltips, project);
    }
    return project(drafts);
  }, [tooltips, drafts]);
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
        1: exports ?? data?.bundle.tooltips[1],
        2: variables ?? data?.bundle.tooltips[2],
        3: titles ?? data?.bundle.tooltips[3],
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
