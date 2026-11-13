import { create } from 'zustand';
import {
  hasSandboxTargets,
  mergeSandboxPointers,
  type Aliases,
  type SandboxConflicts,
  type SandboxPointers,
} from '@clarity/core';
import { loadGenerator, loadSandboxConflicts } from '../services/generator';
import { loadBundle, type Bundle } from '../services/bundle';
import { errorMessage } from '../services/http';
import { applySavedOverlay, savedOverlayVersion } from './savedOverlay';

export type Catalog = Awaited<ReturnType<typeof loadGenerator>>;
export interface EditorData extends Catalog {
  bundle: Bundle;
  /**
   * The generator's own aliases; `aliases` is these plus the maintainer sandbox picks (core
   * mergeSandboxPointers), exactly what push and publish digest and export with. Absent in
   * fixtures that build EditorData by hand (then `aliases` is the generator's).
   */
  generatorAliases?: Aliases;
  /** The generator's shared sandbox perks, once loaded. */
  sandboxConflicts?: SandboxConflicts;
}
interface DataState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: EditorData | null;
  error: string | null;
  load(): Promise<void>;
}

/**
 * Editor data with the picks applied. Without a pick that points at a tooltip, `aliases` stays the
 * generator's very object, so alias-keyed caches and every digest are exactly as before.
 */
export function withSandboxPicks(
  data: EditorData,
  pointers: SandboxPointers | undefined,
  conflicts = data.sandboxConflicts,
): EditorData {
  const generatorAliases = data.generatorAliases ?? data.aliases;
  const aliases = conflicts
    ? mergeSandboxPointers(generatorAliases, conflicts, pointers)
    : generatorAliases;
  return {
    ...data,
    aliases,
    generatorAliases,
    ...(conflicts ? { sandboxConflicts: conflicts } : {}),
    bundle: { ...data.bundle, sandboxPointers: pointers },
  };
}

let conflictsRequest: Promise<SandboxConflicts | undefined> | undefined;
/**
 * One request per session for the generator's shared sandbox perks, reused by the worklist; a
 * failure resolves undefined (picks then stay unapplied, and a push is refused as changed).
 */
export function sharedSandboxConflicts(): Promise<SandboxConflicts | undefined> {
  conflictsRequest ??= Promise.resolve()
    .then(() => loadSandboxConflicts())
    .catch(() => {
      conflictsRequest = undefined;
      return undefined;
    });
  return conflictsRequest;
}

/**
 * Resolves in a new task. A MessageChannel message is used rather than a timer, which a
 * background tab would throttle to a second or more.
 */
function nextTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

export const useDataStore = create<DataState>((set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  async load() {
    if (get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      // The conflicts file is small; it loads alongside, and is awaited only when picks need it.
      const conflicts = sharedSandboxConflicts();
      // Only a head start for the finder: without it the finder groups the data when it renders.
      const navigation = import('../features/navigation/catalog').catch(() => undefined);
      const [catalog, bundle] = await Promise.all([loadGenerator(), loadBundle()]);
      const picks = hasSandboxTargets(bundle.sandboxPointers) ? await conflicts : undefined;
      const assemble = (): EditorData => {
        const base: EditorData = {
          ...catalog,
          generatorAliases: catalog.aliases,
          bundle: applySavedOverlay(bundle),
        };
        return hasSandboxTargets(bundle.sandboxPointers)
          ? withSandboxPicks(base, bundle.sandboxPointers, picks)
          : base;
      };
      // Landing work is split into tasks so that none runs long: the responses' parsing above,
      // the finder's grouping of the catalog here, and the first render of the data after `set`.
      const prepare = (await navigation)?.prepareNavigationGroups;
      await nextTask();
      const overlay = savedOverlayVersion();
      let data = assemble();
      prepare?.(data);
      await nextTask();
      // A save that finished meanwhile still shows (the finder then groups this data itself).
      if (savedOverlayVersion() !== overlay) data = assemble();
      set({ status: 'ready', data });
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) });
    }
  },
}));
