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
}
export interface GlobalSyncState {
  status: 'sync-pending' | 'sync-failed' | 'current';
  lastFailure?: string;
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
