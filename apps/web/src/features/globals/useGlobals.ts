import { useMemo, useSyncExternalStore } from 'react';
import { globalDefinitions, globalUsageEntries, createGlobalUsageProjection } from './model';
import type { EditorData } from '../../stores/data';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

// Derived globals never subscribe with a resolver on the authoring store's input path.
// Visible surfaces refresh after a presented frame; hidden surfaces do no draft work.
const noDrafts: ReturnType<typeof useDraftStore.getState>['drafts'] = {};
let paintedDrafts = useDraftStore.getState().drafts;
const listeners = new Set<() => void>();
let unsubscribeDrafts: (() => void) | undefined;
let frame: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
function subscribePainted(listener: () => void) {
  if (!listeners.size) {
    paintedDrafts = useDraftStore.getState().drafts;
    unsubscribeDrafts = useDraftStore.subscribe((state, previous) => {
      if (state.drafts === previous.drafts || frame !== undefined || timer !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        timer = setTimeout(() => {
          timer = undefined;
          paintedDrafts = useDraftStore.getState().drafts;
          listeners.forEach((notify) => notify());
        }, 0);
      });
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribeDrafts?.();
      unsubscribeDrafts = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      frame = undefined;
      timer = undefined;
    }
  };
}
const subscribeNothing = () => () => {};
function usePaintedDrafts(enabled = true) {
  const snapshot = () => (enabled ? paintedDrafts : noDrafts);
  return useSyncExternalStore(enabled ? subscribePainted : subscribeNothing, snapshot, snapshot);
}

const projections = new WeakMap<object, ReturnType<typeof createGlobalUsageProjection>>();
const noTooltips = {};
export function useGlobals() {
  const tooltips = useDataStore((state) => state.data?.bundle.tooltips ?? noTooltips);
  const drafts = usePaintedDrafts();
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
export function useGlobalDefinitions(override?: EditorData, enabled = true) {
  const stored = useDataStore((state) => state.data);
  const data = override ?? stored;
  const drafts = usePaintedDrafts(enabled);
  const variables = drafts[2]?.next;
  const titles = drafts[3]?.next;
  const exports = drafts[1]?.next;
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
export function useGlobalCatalog(data: EditorData, live = true) {
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
  const snapshot = () =>
    select({ drafts: live ? paintedDrafts : noDrafts } as ReturnType<
      typeof useDraftStore.getState
    >);
  return useSyncExternalStore(live ? subscribePainted : subscribeNothing, snapshot, snapshot);
}

export function useGlobalHover(
  entry?: ReturnType<typeof globalDefinitions>[number],
  data?: EditorData,
) {
  const draft = useDraftStore((state) => (entry ? state.drafts[entry.hash]?.next : undefined));
  const source = draft ?? (entry && data?.bundle.tooltips[entry.hash]);
  return useMemo(() => {
    if (!entry) return undefined;
    const current = source
      ? globalDefinitions({ [source.hash]: source }).find(({ name }) => name === entry.name)
      : entry;
    return Object.values(current?.definitions ?? {}).join('\n\n');
  }, [source, entry]);
}

const noUsages: ReturnType<typeof globalUsageEntries>[number]['usages'] = [];
export function useGlobalUsages(hash: number, name: string) {
  const tooltips = useDataStore((state) => state.data?.bundle.tooltips ?? noTooltips);
  const snapshot = useMemo(() => {
    let project = projections.get(tooltips);
    if (!project) {
      project = createGlobalUsageProjection(tooltips);
      projections.set(tooltips, project);
    }
    return () =>
      project!(paintedDrafts).find((entry) => entry.hash === hash && entry.name === name)?.usages ??
      noUsages;
  }, [tooltips, hash, name]);
  return useSyncExternalStore(subscribePainted, snapshot, snapshot);
}
