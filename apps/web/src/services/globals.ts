import type { GlobalKind, GlobalRecord, Lang } from '@clarity/core';

export type EntryKind = GlobalKind;
export type GlobalActor = {
  role: 'trial' | 'translator' | 'editor' | 'maintainer';
  languages: Lang[];
} | null;
export type GlobalEntry = GlobalRecord;
export interface GlobalSnapshot {
  head: string;
  entries: GlobalEntry[];
  sourceBodies?: Record<string, Partial<Record<Lang, string>>>;
  renameIntents?: Record<string, GlobalRenameIntent>;
}
interface GlobalRenameIntent {
  intentId: string;
  name: string;
  status: 'queued' | 'not-applied';
}
export type GlobalMutation =
  | { operation: 'create'; kind: EntryKind; name: string; lang: Lang; body: string }
  | { operation: 'edit'; id: string; revision: string; lang: Lang; body: string }
  | { operation: 'rename'; id: string; revision: string; name: string }
  | { operation: 'remove'; id: string; revision: string; lang?: Lang };
export type GlobalResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'conflict' | 'retry' | 'invalid' | 'forbidden'; message: string };

type ReadGlobalEntry = (id: string) => Promise<GlobalResult<GlobalSnapshot>>;
export interface GlobalsService {
  read(): Promise<GlobalResult<GlobalSnapshot>>;
  readCatalog?(): Promise<GlobalResult<GlobalSnapshot>>;
  readEntry?: ReadGlobalEntry;
  mutate(request: {
    expectedHead: string;
    mutation: GlobalMutation;
  }): Promise<GlobalResult<GlobalSnapshot>>;
}

export type GlobalCatalog = Pick<GlobalSnapshot, 'head' | 'entries'>;
export interface GlobalEntryDelta {
  head: string;
  entry: GlobalEntry;
  causeIds: string[];
  renameCompleted?: false;
  intentId?: string;
}
export interface GlobalsTransport {
  entry(id: string): Promise<GlobalResult<GlobalEntryDelta>>;
  mutate(request: Parameters<GlobalsService['mutate']>[0]): Promise<GlobalResult<GlobalEntryDelta>>;
}

/** The bundle supplies the catalogue. The Worker supplies the opened entry and write head. */
export function createGlobalsService(
  transport: GlobalsTransport,
  options: {
    catalog(): Promise<GlobalResult<GlobalCatalog>>;
    initialSnapshot?: GlobalSnapshot;
    onCatalog?(entries: readonly GlobalEntry[]): void;
    onEntrySaved?(entry: GlobalEntry, head: string): void;
  },
): GlobalsService & { readEntry: ReadGlobalEntry } {
  let cached = options.initialSnapshot && structuredClone(options.initialSnapshot);
  let generation = 0;
  let catalogRead: Promise<GlobalResult<GlobalSnapshot>> | undefined;
  let entryRead:
    | { id: string; generation: number; promise: Promise<GlobalResult<GlobalSnapshot>> }
    | undefined;
  const conflict = (): GlobalResult<GlobalSnapshot> => ({
    kind: 'conflict',
    message: 'Globals changed. Refresh to load the current snapshot.',
  });
  const invalid = (message: string): GlobalResult<GlobalSnapshot> => ({ kind: 'invalid', message });
  function mergeEntry(next: GlobalSnapshot, entry: GlobalEntry) {
    const old = next.entries.findIndex((item) => item.id === entry.id);
    if (old < 0) next.entries.push(entry);
    else {
      if (next.entries[old].revision !== entry.revision && next.sourceBodies)
        delete next.sourceBodies[entry.id];
      next.entries[old] = entry;
    }
  }
  function applyEntry(next: GlobalSnapshot, value: GlobalEntryDelta) {
    next.head = value.head;
    mergeEntry(next, value.entry);
    // Only the Worker's response for this entry can settle its queued rename.
    const intents = next.renameIntents;
    const intent = intents?.[value.entry.id];
    if (intents && intent && !value.causeIds.includes(intent.intentId)) {
      if (value.entry.name === intent.name) delete intents[value.entry.id];
      else intent.status = 'not-applied';
    }
  }
  function publish(next: GlobalSnapshot, token: number): GlobalResult<GlobalSnapshot> {
    if (token !== generation) return conflict();
    cached = next;
    return { kind: 'ok', value: structuredClone(next) };
  }

  async function read() {
    const token = ++generation;
    const catalog = await options.catalog();
    if (catalog.kind !== 'ok') return catalog;
    if (token !== generation) return conflict();
    const { head, entries } = catalog.value;
    if (new Set(entries.map(({ id }) => id)).size !== entries.length)
      return invalid('Duplicate global identity in catalog.');
    const next: GlobalSnapshot = {
      head,
      entries: structuredClone(entries),
      sourceBodies: structuredClone(cached?.sourceBodies ?? {}),
      renameIntents: structuredClone(cached?.renameIntents ?? {}),
    };
    for (const entry of entries)
      if (cached?.entries.find((old) => old.id === entry.id)?.revision !== entry.revision)
        delete next.sourceBodies![entry.id];
    options.onCatalog?.([...next.entries]);
    return publish(next, token);
  }

  async function readEntry(id: string) {
    const token = ++generation;
    if (!cached) return conflict();
    const result = await transport.entry(id);
    if (result.kind !== 'ok') return result;
    if (token !== generation) return conflict();
    if (result.value.entry.id !== id) return invalid('Global entry read names another entry.');
    const next = structuredClone(cached);
    applyEntry(next, result.value);
    return publish(next, token);
  }
  return {
    read,
    readCatalog() {
      if (catalogRead) return catalogRead;
      if (cached) return Promise.resolve({ kind: 'ok' as const, value: structuredClone(cached) });
      const pending = read().finally(() => {
        if (catalogRead === pending) catalogRead = undefined;
      });
      catalogRead = pending;
      return pending;
    },
    readEntry(id) {
      if (entryRead?.id === id && entryRead.generation === generation) return entryRead.promise;
      const pending = readEntry(id).finally(() => {
        if (entryRead?.promise === pending) entryRead = undefined;
      });
      entryRead = { id, generation, promise: pending };
      return pending;
    },
    async mutate(request) {
      const token = ++generation;
      if (!cached || request.expectedHead !== cached.head) return conflict();
      const next = structuredClone(cached);
      const response = await transport.mutate(request);
      if (response.kind !== 'ok') return response;
      if (token !== generation) return conflict();
      const value = response.value;
      const { mutation } = request;
      if (mutation.operation === 'create') {
        if (next.entries.some((entry) => entry.id === value.entry.id))
          return invalid('Global create reused an existing identity.');
      } else if (value.entry.id !== mutation.id) return invalid('Unexpected global entry receipt.');
      if (mutation.operation === 'rename') {
        if (
          value.renameCompleted !== false ||
          !value.intentId ||
          !value.causeIds.includes(value.intentId)
        )
          return invalid('Rename intent receipt is incomplete.');
        if (next.entries.find((entry) => entry.id === mutation.id)?.name !== value.entry.name)
          return invalid('Queued rename changed the name before completion.');
        applyEntry(next, value);
        (next.renameIntents ??= {})[mutation.id] = {
          intentId: value.intentId,
          name: mutation.name,
          status: 'queued',
        };
      } else {
        if (value.renameCompleted === false) return invalid('Unexpected global entry receipt.');
        applyEntry(next, value);
        options.onEntrySaved?.(value.entry, value.head);
      }
      return publish(next, token);
    },
  };
}

export function canEditGlobal(actor: GlobalActor, lang: Lang) {
  return !!actor && (actor.role !== 'translator' || actor.languages.includes(lang));
}
