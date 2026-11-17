import { create } from 'zustand';
import type { Lang } from '@clarity/core';
import type { GlobalDefinition } from '../features/globals/model';

/**
 * Stable identity of a live global entry: its ID never changes, its name can. Kept apart from
 * the globals service (a lazy chunk) so the finder can map routes without loading it.
 */
export interface GlobalIdentity {
  kind: 'variables' | 'titles';
  name: string;
  /** Saved bodies by language, for finder hovers. */
  definitions: Partial<Record<Lang, string>>;
}

interface GlobalIdentitiesState {
  /** Live (not removed) entries by stable ID, from the last authoritative catalogue read. */
  identities: Record<string, GlobalIdentity>;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string;
}

export const useGlobalIdentities = create<GlobalIdentitiesState>(() => ({
  identities: {},
  status: 'idle',
  error: '',
}));

export const globalEntryPath = /^\/globals\/(g_[A-Za-z0-9_-]{8,80})$/;

/** The stable ID of a live entry named `name`, if the catalogue has loaded. */
export function globalIdOf(
  identities: Record<string, GlobalIdentity>,
  kind: string,
  name: string,
): string | undefined {
  for (const [id, identity] of Object.entries(identities))
    if (identity.kind === kind && identity.name === name) return id;
  return undefined;
}

/**
 * The finder's variables and titles from authoritative live entries (new and renamed ones
 * included, removed ones left out), in the aggregate catalogue's shape and order.
 */
export function identityDefinitions(
  identities: Record<string, GlobalIdentity>,
): GlobalDefinition[] {
  return Object.values(identities)
    .map(({ kind, name, definitions }) => ({
      kind,
      hash: kind === 'variables' ? 2 : 3,
      name,
      definitions,
      lines: {},
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/**
 * A `/globals/:id` route in the finder's aggregate terms (`/t/2?global=Name`), so stepping,
 * selection, and the phone title treat a stable-ID entry like the declaration it opens.
 */
export function aggregateGlobalRoute(
  path: string,
  search: string,
  identities: Record<string, GlobalIdentity> = useGlobalIdentities.getState().identities,
): { hash: number; search: string } | undefined {
  const id = globalEntryPath.exec(path)?.[1];
  const identity = id ? identities[id] : undefined;
  if (!identity) return undefined;
  const params = new URLSearchParams(search);
  params.set('global', identity.name);
  return { hash: identity.kind === 'variables' ? 2 : 3, search: `?${params}` };
}
