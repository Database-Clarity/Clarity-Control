import type {
  GlobalImpact,
  GlobalImpactChange,
  GlobalImpactRow,
  GlobalImpactSnapshot,
  GlobalKind,
  GlobalRecord,
  GlobalReview,
  Lang,
} from '@clarity/core';

// UI service and browser projection boundary. Live transport/mounting waits for S2B/S5 and the owner gates.
export type EntryKind = GlobalKind;
export type GlobalActor = {
  role: 'trial' | 'translator' | 'editor' | 'maintainer';
  languages: Lang[];
} | null;
export type GlobalEntry = GlobalRecord;
/** S1 impact and review records, plus non-authoritative navigation/display metadata. */
export interface GlobalConsumerView extends GlobalImpactRow {
  id: string;
  variant: number;
  name: string;
  category: string;
  line: number | null;
  path: string[] | null;
  direct: boolean | null;
  archived: boolean;
  beforeSource: string;
  afterSource: string;
}
export interface GlobalConsumer extends GlobalConsumerView {
  review: GlobalReview;
  impactDigest: string;
}

export interface GlobalProjectionInput {
  before: GlobalImpactSnapshot;
  after: GlobalImpactSnapshot;
  changes: GlobalImpactChange[];
  destination: string;
}
export interface GlobalProjectionRequest {
  expectedHead: string;
  id: string;
  revision: string;
  lang: Lang;
  body: string;
}
/** S5 supplies pinned snapshots and display metadata; no HTTP endpoint resolves a draft. */
export interface GlobalProjectionSource {
  prepare(request: GlobalProjectionRequest): GlobalProjectionInput;
  describe(row: GlobalImpactRow, input: GlobalProjectionInput): GlobalConsumerView;
}
export type GlobalsImpactRequest = { id: number; input: GlobalProjectionInput };
export type GlobalsImpactReply = { id: number; result?: GlobalImpact; error?: string };
export interface GlobalImpactProjector {
  calculate(input: GlobalProjectionInput, signal?: AbortSignal): Promise<GlobalImpact>;
  dispose(): void;
}

/** S1 is synchronous inside the worker: terminating it cancels its CPU work as well as its reply. */
export function createGlobalImpactProjector(
  createWorker: () => Worker = () =>
    new Worker(new URL('./globalsImpact.worker.ts', import.meta.url), { type: 'module' }),
): GlobalImpactProjector {
  let cancelActive: (() => void) | undefined;
  let sequence = 0;
  return {
    calculate(input, signal) {
      cancelActive?.();
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Calculation cancelled.', 'AbortError'));
          return;
        }
        const worker = createWorker();
        const id = ++sequence;
        let finished = false;
        const finish = (callback: () => void) => {
          if (finished) return;
          finished = true;
          worker.terminate();
          signal?.removeEventListener('abort', cancel);
          if (cancelActive === cancel) cancelActive = undefined;
          callback();
        };
        const cancel = () =>
          finish(() => reject(new DOMException('Calculation cancelled.', 'AbortError')));
        cancelActive = cancel;
        signal?.addEventListener('abort', cancel, { once: true });
        worker.onmessage = (event: MessageEvent<GlobalsImpactReply>) => {
          if (event.data.id !== id) return;
          finish(() =>
            event.data.result
              ? resolve(event.data.result)
              : reject(new Error(event.data.error ?? 'Projected calculation failed.')),
          );
        };
        worker.onerror = (event) => {
          event.preventDefault();
          finish(() => reject(new Error(event.message || 'Projected calculation worker failed.')));
        };
        try {
          worker.postMessage({ id, input } satisfies GlobalsImpactRequest);
        } catch (error) {
          finish(() => reject(error));
        }
      });
    },
    dispose() {
      cancelActive?.();
    },
  };
}
export interface GlobalSnapshot {
  head: string;
  entries: GlobalEntry[];
  impacts: Record<string, GlobalConsumer[]>;
  sourceBodies?: Record<string, Partial<Record<Lang, string>>>;
  sync: Record<string, GlobalSyncState>;
  destinationSync: Record<string, GlobalSyncState>;
  renameIntents?: Record<string, GlobalRenameIntent>;
  sources?: GlobalSourcePins;
  /** Which entry owns each pending cause; a Retry sends only the selected entry's own. */
  causeEntries?: Record<string, string>;
}
/**
 * A queued rename. `name` is the requested name; once sync is current an intent whose entry does
 * not carry that name was refused (stale intent, S4 R2) and reads `not-applied` until the next
 * current refresh.
 */
export interface GlobalRenameIntent {
  intentId: string;
  renameCompleted: false;
  name?: string;
  status?: 'queued' | 'not-applied';
}
export interface GlobalSyncState {
  status: 'sync-pending' | 'sync-failed' | 'current';
  lastFailure?: string | null;
  causeIds: string[];
}
const unknownSync: GlobalSyncState = { status: 'sync-pending', causeIds: [] };
export function globalSyncState(snapshot: GlobalSnapshot, id: string): GlobalSyncState {
  return snapshot.sync[id] ?? unknownSync;
}
export function canAcknowledgeGlobal(
  snapshot: GlobalSnapshot,
  id: string,
  row: GlobalConsumer,
): boolean {
  return (
    globalSyncState(snapshot, id).status === 'current' &&
    snapshot.destinationSync[row.consumer.destination]?.status === 'current' &&
    globalReviewState(row) === 'required'
  );
}
export type GlobalMutation =
  | { operation: 'create'; kind: EntryKind; name: string; lang: Lang; body: string }
  | { operation: 'edit'; id: string; revision: string; lang: Lang; body: string }
  | { operation: 'rename'; id: string; revision: string; name: string }
  | { operation: 'remove'; id: string; revision: string; lang?: Lang }
  | {
      operation: 'acknowledge';
      id: string;
      consumerId: string;
      contentDigest: string;
      dependencyDigest: string;
      impactDigest: string;
      decision: 'no-text-change';
    };
export type GlobalResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'conflict'; message: string }
  | { kind: 'retry'; message: string }
  | { kind: 'invalid' | 'forbidden'; message: string };
export interface GlobalsService {
  read(): Promise<GlobalResult<GlobalSnapshot>>;
  /** Catalogue-only reads can be shared by the finder and workspace. */
  readCatalog?(): Promise<GlobalResult<GlobalSnapshot>>;
  readEntry?(id: string): Promise<GlobalResult<GlobalSnapshot>>;
  mutate(request: {
    expectedHead: string;
    mutation: GlobalMutation;
  }): Promise<GlobalResult<GlobalSnapshot>>;
  retrySync(request: {
    expectedHead: string;
    id: string;
    causeIds: string[];
  }): Promise<GlobalResult<GlobalSnapshot>>;
}

/** Structurally matches S2B model.ts Sources; no browser import of server runtime/context. */
export interface GlobalSourcePins {
  authored: string;
  definitions: string;
  projections: string;
  config: string;
  live: string;
  upcoming: string;
  aliases: string;
  generator: string;
  fallback: string;
  resolver: string;
}
export interface GlobalHttpState extends GlobalSyncState {
  head: string;
  version: 1;
  sources?: GlobalSourcePins;
  causeEntries?: Record<string, string>;
}
export interface GlobalEntryPage extends GlobalHttpState {
  entries: GlobalEntry[];
  nextCursor: string | null;
}
export interface GlobalReviewPage extends GlobalHttpState {
  consumers: GlobalConsumer[];
  nextCursor: string | null;
}
export interface GlobalEntryDelta extends GlobalHttpState {
  entry: GlobalEntry;
  renameCompleted?: false;
  intentId?: string;
}
export interface GlobalAuditDelta extends GlobalHttpState {
  consumerId: string;
  review: GlobalReview;
}
/** Bounded HTTP responses, not whole UI snapshots. S5 supplies authenticated transport. */
export interface GlobalsTransport {
  list(cursor: string): Promise<GlobalResult<GlobalEntryPage>>;
  entry(id: string): Promise<GlobalResult<GlobalEntryDelta>>;
  reviews(id: string, cursor: string): Promise<GlobalResult<GlobalReviewPage>>;
  mutate(
    request: Parameters<GlobalsService['mutate']>[0],
  ): Promise<GlobalResult<GlobalEntryDelta | GlobalAuditDelta>>;
  retrySync(
    request: Parameters<GlobalsService['retrySync']>[0],
  ): Promise<GlobalResult<GlobalEntryDelta>>;
}

/** Compose only complete reads, or merge a bounded CAS receipt into the known client snapshot. */
export function createGlobalsService(
  transport: GlobalsTransport,
  options: {
    destinations: readonly string[];
    initialSnapshot?: GlobalSnapshot;
    lazyReviews?: boolean;
    onCatalogPage?(entries: readonly GlobalEntry[], complete: boolean): void;
  },
): GlobalsService & { readEntry(id: string): Promise<GlobalResult<GlobalSnapshot>> } {
  let cached = options.initialSnapshot && structuredClone(options.initialSnapshot);
  let generation = 0;
  let catalogRead: Promise<GlobalResult<GlobalSnapshot>> | undefined;
  let entryRead:
    { id: string; generation: number; promise: Promise<GlobalResult<GlobalSnapshot>> } | undefined;
  const conflict = (): GlobalResult<GlobalSnapshot> => ({
    kind: 'conflict',
    message: 'Globals changed. Refresh to load the current snapshot.',
  });
  const invalid = (message: string): GlobalResult<GlobalSnapshot> => ({ kind: 'invalid', message });
  const state = (header: GlobalHttpState): GlobalSyncState => ({
    status: header.status,
    lastFailure: header.lastFailure,
    causeIds: [...header.causeIds],
  });
  const sourceKey = (sources?: GlobalSourcePins) =>
    sources &&
    JSON.stringify([
      sources.authored,
      sources.definitions,
      sources.projections,
      sources.config,
      sources.live,
      sources.upcoming,
      sources.aliases,
      sources.generator,
      sources.fallback,
      sources.resolver,
    ]);
  const sameHeader = (a: GlobalHttpState, b: GlobalHttpState) =>
    a.head === b.head &&
    a.status === b.status &&
    a.lastFailure === b.lastFailure &&
    JSON.stringify(a.causeIds) === JSON.stringify(b.causeIds) &&
    sourceKey(a.sources) === sourceKey(b.sources);
  function applyState(next: GlobalSnapshot, header: GlobalHttpState) {
    next.head = header.head;
    next.sources = header.sources;
    // Cause ownership never changes, so receipts only add to it; current sync has no causes.
    next.causeEntries =
      header.status === 'current' ? {} : { ...next.causeEntries, ...header.causeEntries };
    next.sync = Object.fromEntries(next.entries.map((entry) => [entry.id, state(header)]));
    next.destinationSync = Object.fromEntries(
      options.destinations.map((destination) => [destination, state(header)]),
    );
    if (header.status === 'current')
      next.renameIntents = Object.fromEntries(
        Object.entries(next.renameIntents ?? {}).flatMap(([id, intent]) => {
          const entry = next.entries.find((item) => item.id === id);
          // Reported once already, or applied (or no requested name to compare): cleared.
          if (
            intent.status === 'not-applied' ||
            !intent.name ||
            !entry ||
            entry.name === intent.name
          )
            return [];
          return [[id, { ...intent, status: 'not-applied' as const }]];
        }),
      );
  }
  function mergeEntry(next: GlobalSnapshot, entry: GlobalEntry) {
    const old = next.entries.findIndex((item) => item.id === entry.id);
    if (old < 0) next.entries.push(entry);
    else {
      if (next.entries[old].revision !== entry.revision && next.sourceBodies)
        delete next.sourceBodies[entry.id];
      next.entries[old] = entry;
    }
  }
  function publish(next: GlobalSnapshot, token: number): GlobalResult<GlobalSnapshot> {
    if (token !== generation) return conflict();
    cached = next;
    return { kind: 'ok', value: structuredClone(next) };
  }
  async function readReviews(
    id: string,
    header: GlobalHttpState,
    token: number,
  ): Promise<GlobalResult<GlobalConsumer[]>> {
    const consumers: GlobalConsumer[] = [],
      cursors = new Set<string>(),
      ids = new Set<string>();
    let cursor: string | null = 'p0';
    while (cursor !== null) {
      if (!/^p\d{1,5}$/.test(cursor) || cursors.has(cursor))
        return { kind: 'invalid', message: 'Invalid global review cursor.' };
      cursors.add(cursor);
      const page = await transport.reviews(id, cursor);
      if (token !== generation)
        return { kind: 'conflict', message: 'A newer globals request replaced this read.' };
      if (page.kind !== 'ok') return page;
      if (!sameHeader(header, page.value))
        return { kind: 'conflict', message: 'Global review pages changed. Refresh again.' };
      if (page.value.consumers.length > 3 || page.value.consumers.some((row) => ids.has(row.id)))
        return { kind: 'invalid', message: 'Invalid global review page.' };
      for (const row of page.value.consumers) {
        if (ids.has(row.id)) return { kind: 'invalid', message: 'Duplicate global review.' };
        ids.add(row.id);
        consumers.push(row);
      }
      cursor = page.value.nextCursor;
    }
    return { kind: 'ok', value: consumers };
  }
  async function delta(
    request: Parameters<GlobalsService['mutate']>[0] | Parameters<GlobalsService['retrySync']>[0],
    retry: boolean,
  ): Promise<GlobalResult<GlobalSnapshot>> {
    const token = ++generation;
    if (!cached || request.expectedHead !== cached.head) return conflict();
    const base = structuredClone(cached);
    const response = retry
      ? await transport.retrySync(request as Parameters<GlobalsService['retrySync']>[0])
      : await transport.mutate(request as Parameters<GlobalsService['mutate']>[0]);
    if (response.kind !== 'ok') return response;
    if (token !== generation) return conflict();
    const value = response.value;
    const mutation = 'mutation' in request ? request.mutation : undefined;
    if ('entry' in value) {
      const expectedId =
        mutation?.operation === 'create'
          ? value.entry.id
          : mutation && 'id' in mutation
            ? mutation.id
            : 'id' in request
              ? request.id
              : undefined;
      if (value.entry.id !== expectedId || mutation?.operation === 'acknowledge')
        return invalid('Unexpected global entry receipt.');
      if (
        mutation?.operation === 'create' &&
        base.entries.some((entry) => entry.id === value.entry.id)
      )
        return invalid('Global create reused an existing identity.');
      if (mutation && value.status !== 'sync-pending')
        return invalid('Global admission did not report Sync pending.');
      if (mutation?.operation === 'rename' && (value.renameCompleted !== false || !value.intentId))
        return invalid('Rename intent receipt is incomplete.');
      if (
        mutation?.operation === 'rename' &&
        base.entries.find((entry) => entry.id === mutation.id)?.name !== value.entry.name
      )
        return invalid('Queued rename changed the name before completion.');
      mergeEntry(base, value.entry);
      applyState(base, value);
      if (value.renameCompleted === false && value.intentId)
        base.renameIntents = {
          ...base.renameIntents,
          [value.entry.id]: {
            intentId: value.intentId,
            renameCompleted: false,
            ...(mutation?.operation === 'rename' ? { name: mutation.name } : {}),
            status: 'queued',
          },
        };
    } else {
      if (mutation?.operation !== 'acknowledge' || value.consumerId !== mutation.consumerId)
        return invalid('Unexpected global review receipt.');
      if (value.status !== 'current') return invalid('Global acknowledgement is not current.');
      const ack = value.review.acknowledgement;
      if (
        !ack ||
        ack.contentDigest !== mutation.contentDigest ||
        ack.dependencyDigest !== mutation.dependencyDigest ||
        ack.impactDigest !== mutation.impactDigest ||
        ack.decision !== mutation.decision
      )
        return invalid('Global acknowledgement receipt is stale.');
      let found = false;
      for (const rows of Object.values(base.impacts))
        for (const row of rows)
          if (row.id === value.consumerId) {
            if (
              JSON.stringify(row.consumer) !== JSON.stringify(value.review.consumer) ||
              JSON.stringify(row.causes) !== JSON.stringify(value.review.causes)
            )
              return invalid('Global review identity changed.');
            row.review = value.review;
            found = true;
          }
      if (!found) return conflict();
      applyState(base, value);
    }
    return publish(base, token);
  }
  const service: GlobalsService & {
    readEntry(id: string): Promise<GlobalResult<GlobalSnapshot>>;
  } = {
    async read() {
      const token = ++generation;
      const next: GlobalSnapshot = {
        head: '',
        entries: [],
        impacts: {},
        sync: {},
        destinationSync: {},
        sourceBodies: structuredClone(cached?.sourceBodies ?? {}),
        renameIntents: structuredClone(cached?.renameIntents ?? {}),
      };
      const cursors = new Set<string>(),
        ids = new Set<string>();
      let header: GlobalHttpState | undefined,
        cursor: string | null = 'p0';
      while (cursor !== null) {
        if (!/^p\d{1,5}$/.test(cursor) || cursors.has(cursor))
          return invalid('Invalid global catalog cursor.');
        cursors.add(cursor);
        const page = await transport.list(cursor);
        if (page.kind !== 'ok') return page;
        if (token !== generation) return conflict();
        if (header && !sameHeader(header, page.value)) return conflict();
        header ??= page.value;
        next.causeEntries = { ...next.causeEntries, ...page.value.causeEntries };
        if (page.value.entries.length > 3)
          return invalid('Global catalog page exceeds three records.');
        for (const entry of page.value.entries) {
          if (ids.has(entry.id)) return invalid('Duplicate global identity in catalog.');
          ids.add(entry.id);
          next.entries.push(entry);
          if (
            cached?.entries.find((old) => old.id === entry.id)?.revision !== entry.revision &&
            next.sourceBodies
          )
            delete next.sourceBodies[entry.id];
          if (!options.lazyReviews && header.status === 'current' && !entry.tombstone) {
            const reviews = await readReviews(entry.id, header, token);
            if (reviews.kind !== 'ok') return reviews;
            next.impacts[entry.id] = reviews.value;
          } else if (!options.lazyReviews || header.status !== 'current' || entry.tombstone)
            next.impacts[entry.id] = structuredClone(cached?.impacts[entry.id] ?? []);
        }
        cursor = page.value.nextCursor;
        options.onCatalogPage?.([...next.entries], cursor === null);
      }
      applyState(next, header!);
      return publish(next, token);
    },
    async readEntry(id) {
      const token = ++generation;
      if (!cached) return conflict();
      const entry = await transport.entry(id);
      if (entry.kind !== 'ok') return entry;
      if (
        entry.value.head !== cached.head ||
        entry.value.entry.id !== id ||
        sourceKey(entry.value.sources) !== sourceKey(cached.sources)
      )
        return conflict();
      const next = structuredClone(cached);
      mergeEntry(next, entry.value.entry);
      applyState(next, entry.value);
      if (entry.value.status === 'current' && !entry.value.entry.tombstone) {
        const rows = await readReviews(id, entry.value, token);
        if (rows.kind !== 'ok') return rows;
        next.impacts[id] = rows.value;
      } else next.impacts[id] = structuredClone(cached.impacts[id] ?? []);
      return publish(next, token);
    },
    mutate: (request) => delta(request, false),
    retrySync: (request) => delta(request, true),
  };
  return {
    ...service,
    readEntry(id) {
      if (entryRead?.id === id && entryRead.generation === generation) return entryRead.promise;
      const pending = service.readEntry(id).finally(() => {
        if (entryRead?.promise === pending) entryRead = undefined;
      });
      entryRead = { id, generation, promise: pending };
      return pending;
    },
    readCatalog() {
      if (catalogRead) return catalogRead;
      if (cached) return Promise.resolve({ kind: 'ok' as const, value: structuredClone(cached) });
      const pending = service.read().finally(() => {
        if (catalogRead === pending) catalogRead = undefined;
      });
      catalogRead = pending;
      return pending;
    },
  };
}
export function globalReviewState(row: GlobalConsumer): 'required' | 'acknowledged' | 'stale' {
  const ack = row.review.acknowledgement;
  if (!ack) return 'required';
  return ack.contentDigest === row.review.contentDigest &&
    ack.dependencyDigest === row.review.dependencyDigest &&
    ack.impactDigest === row.impactDigest
    ? 'acknowledged'
    : 'stale';
}
export function canEditGlobal(actor: GlobalActor, lang: Lang) {
  return !!actor && (actor.role !== 'translator' || actor.languages.includes(lang));
}
export function canReviewGlobal(actor: GlobalActor, lang: Lang) {
  return (
    !!actor &&
    (actor.role === 'editor' ||
      actor.role === 'maintainer' ||
      (actor.role === 'translator' && lang !== 'en' && actor.languages.includes(lang)))
  );
}
