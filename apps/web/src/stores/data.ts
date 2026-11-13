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
import { applySavedOverlay } from './savedOverlay';

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
      const [catalog, bundle] = await Promise.all([loadGenerator(), loadBundle()]);
      const base: EditorData = {
        ...catalog,
        generatorAliases: catalog.aliases,
        bundle: applySavedOverlay(bundle),
      };
      const data = hasSandboxTargets(bundle.sandboxPointers)
        ? withSandboxPicks(base, bundle.sandboxPointers, await conflicts)
        : base;
      set({ status: 'ready', data });
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) });
    }
  },
}));
