import type { RemoteStatus } from './api';

export type OpStatus = 'created' | 'pending' | RemoteStatus;
export const isTerminal = (status: OpStatus) => status !== 'created' && status !== 'pending';

/**
 * One request (a chunk of a confirmed publish). Written BEFORE the first send with immutable identity, so
 * a lost 202, a reload or a second tab always resends the same opId and the same body.
 */
export interface PublishOp {
  opId: string;
  /** Shared logical publish; each chunk keeps its own immutable request identity. */
  groupId?: string;
  groupSize?: number;
  /** Stable dependency order; ULID random tails do not encode chunk order. */
  groupIndex?: number;
  /** New groups can replace refused requests while preserving their total reviewed hashes. */
  groupHashCount?: number;
  round?: number;
  consumers?: number;
  /** Numeric account id the body was confirmed under; another account never resumes it. */
  userId: string;
  createdAt: number;
  /** Original confirmation time when refused parts are replaced with new requests. */
  groupCreatedAt?: number;
  hashes: number[];
  expected: Record<string, string>;
  /** Globals published by this request, with the reviewed definition; the name is for display. */
  globals?: { id: string; expected: string; name: string }[];
  /** Use the shared-definition publish contract on every attempt, even after reload. */
  switched?: true;
  /** Globals a finished request left out; the rest of it went live. */
  refusedGlobals?: { id: string; name: string; error: string }[];
  /** The pushed marker each hash had when confirmed (null = none), for the acknowledgment overlay. */
  previous: Record<string, string | null>;
  status: OpStatus;
  /** When the Worker first said "queued"; drives the waiting threshold and the auto-kick. */
  acceptedAt?: number;
  /** When this tab last asked the publisher to process this request. */
  kickedAt?: number;
  polledAt?: number;
  /** Plain-language reason for `failed`/`stale`/`rejected` that originates in the client. */
  error?: string;
  /** Authoritative fail-closed refusal recovered from an immutable request receipt. */
  refusal?: string;
  /** A named terminal refusal cannot be resolved by combining requests. */
  regroupable?: false;
  /** Also set for checked rejections that do not qualify for regrouping. */
  receiptChecked?: true;
  updatedAt: number;
  dismissed?: boolean;
}

export interface OpStore {
  list(userId: string): Promise<PublishOp[]>;
  /**
   * All chunks commit atomically before any send, and only when `busy` (given this account's
   * stored operations in the same transaction) says no; resolves with whether they did. Insert-only:
   * an existing opId is never replaced.
   */
  addMany(ops: PublishOp[], busy?: (stored: PublishOp[]) => boolean): Promise<boolean>;
  /** Compare and replace the exact terminal requests in one transaction across tabs. */
  replaceRefused(refused: PublishOp[], replacements: PublishOp[]): Promise<boolean>;
  /**
   * Atomic read-modify-write (one IndexedDB transaction, so two tabs cannot both win a claim). The
   * callback returns the changed record or undefined for "leave it". A terminal status is never
   * overwritten by a different one. Resolves with the stored record, or undefined if missing.
   */
  update(
    opId: string,
    change: (op: PublishOp) => PublishOp | undefined,
  ): Promise<PublishOp | undefined>;
  /** Keep the newest bundle seen by any publisher tab, including after a reload. */
  observeBundle(generatedAt: number, seenAt: number): Promise<void>;
  /** Decide against a consistent view of the group and bundle progress before kicking. */
  claimKick(
    opId: string,
    kickedAt: number,
    ready: (group: PublishOp[], bundleAt: number) => boolean,
  ): Promise<boolean>;
  remove(opIds: string[]): Promise<void>;
}

const dbName = 'clarity-publisher';
const storeName = 'operations';
// A non-ULID key keeps the metadata in the same transaction and remains invisible to older tabs.
const bundleKey = 'bundle-progress';
interface BundleObservation {
  generatedAt: number;
  seenAt: number;
}
type BundleProgress = BundleObservation & { opId: typeof bundleKey };
type StoredRecord = PublishOp | BundleProgress;
const isPublishOp = (record: StoredRecord): record is PublishOp => 'userId' in record;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(storeName, { keyPath: 'opId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Publish storage unavailable'));
    request.onblocked = () =>
      reject(new Error('Publish storage upgrade blocked. Close other tabs.'));
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let value!: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? new Error('Publish storage aborted'));
      transaction.onerror = () => reject(transaction.error);
      work(transaction.objectStore(storeName), (result) => (value = result));
    });
  } finally {
    db.close();
  }
}

export function createIndexedDbOpStore(): OpStore {
  return {
    list: (userId) =>
      run<PublishOp[]>('readonly', (store, done) => {
        store.getAll().onsuccess = (event) =>
          done(
            ((event.target as IDBRequest<StoredRecord[]>).result ?? []).filter(
              (record): record is PublishOp => isPublishOp(record) && record.userId === userId,
            ),
          );
      }),
    addMany: (ops, busy) =>
      run<boolean>('readwrite', (store, done) => {
        const found = store.getAll();
        found.onsuccess = () => {
          const stored = (found.result as StoredRecord[])
            .filter(isPublishOp)
            .filter(({ userId }) => userId === ops[0]?.userId);
          if (busy?.(stored)) return done(false);
          // add() fails (ConstraintError, aborting the transaction) rather than replacing an opId.
          for (const op of ops) store.add(op);
          done(true);
        };
      }),
    replaceRefused: (refused, replacements) =>
      run<boolean>('readwrite', (store, done) => {
        const found = store.getAll();
        found.onsuccess = () => {
          const current = new Map(
            (found.result as StoredRecord[]).filter(isPublishOp).map((op) => [op.opId, op]),
          );
          if (!sameRefusals(refused, current)) return done(false);
          for (const op of replacements) store.add(op);
          for (const op of refused) store.delete(op.opId);
          done(true);
        };
      }),
    update: (opId, change) =>
      run<PublishOp | undefined>('readwrite', (store, done) => {
        store.get(opId).onsuccess = (event) => {
          const current = (event.target as IDBRequest<PublishOp | undefined>).result;
          if (!current) return;
          const next = change(current);
          if (!next) return done(current);
          store.put(guardTerminal(current, next));
          done(guardTerminal(current, next));
        };
      }),
    observeBundle: (generatedAt, seenAt) =>
      run<void>('readwrite', (store) => {
        const progress = store.get(bundleKey) as IDBRequest<BundleProgress | undefined>;
        progress.onsuccess = () => {
          if (generatedAt > (progress.result?.generatedAt ?? 0))
            store.put({ opId: bundleKey, generatedAt, seenAt } satisfies BundleProgress);
        };
      }),
    claimKick: (opId, kickedAt, ready) =>
      run<boolean>('readwrite', (store, done) => {
        const records = store.getAll();
        records.onsuccess = () => {
          const stored = records.result as StoredRecord[];
          const bundle = stored.find((record): record is BundleProgress => !isPublishOp(record));
          const op = kickable(stored.filter(isPublishOp), opId, (group) =>
            ready(group, bundle?.seenAt ?? 0),
          );
          if (op) store.put({ ...op, kickedAt });
          done(op !== undefined);
        };
      }),
    remove: (opIds) =>
      run<void>('readwrite', (store) => {
        for (const id of opIds) store.delete(id);
      }),
  };
}

function sameRefusals(refused: PublishOp[], current: ReadonlyMap<string, PublishOp>): boolean {
  return refused.every(({ opId, userId, refusal }) => {
    const op = current.get(opId);
    return op?.userId === userId && op.status === 'rejected' && op.refusal === refusal;
  });
}

/** Identity fields are immutable; a terminal status sticks. Shared by every store implementation. */
export function guardTerminal(current: PublishOp, next: PublishOp): PublishOp {
  const merged: PublishOp = {
    ...next,
    opId: current.opId,
    groupId: current.groupId,
    groupSize: current.groupSize,
    groupIndex: current.groupIndex,
    groupHashCount: current.groupHashCount,
    round: current.round,
    consumers: current.consumers,
    userId: current.userId,
    createdAt: current.createdAt,
    groupCreatedAt: current.groupCreatedAt,
    hashes: current.hashes,
    expected: current.expected,
    globals: current.globals,
    switched: current.switched,
    previous: current.previous,
  };
  if (isTerminal(current.status) && next.status !== current.status) {
    merged.status = current.status;
    merged.error = current.error;
    merged.refusal = current.refusal;
    merged.refusedGlobals = current.refusedGlobals;
    merged.regroupable = current.regroupable;
    merged.receiptChecked = current.receiptChecked;
  }
  return merged;
}

function kickable(records: PublishOp[], opId: string, ready: (group: PublishOp[]) => boolean) {
  const op = records.find((record) => record.opId === opId);
  if (op?.status !== 'pending') return undefined;
  const group = op.groupId
    ? records.filter((record) => record.groupId === op.groupId && record.userId === op.userId)
    : [op];
  return ready(group) ? op : undefined;
}

/** In-memory store: tests, and the shape the IndexedDB one must keep. */
export function createMemoryOpStore(): OpStore & { records: Map<string, PublishOp> } {
  const records = new Map<string, PublishOp>();
  let bundle: BundleObservation | undefined;
  return {
    records,
    async list(userId) {
      return [...records.values()]
        .filter((op) => op.userId === userId)
        .map((op) => structuredClone(op));
    },
    async addMany(ops, busy) {
      if (busy?.([...records.values()].filter(({ userId }) => userId === ops[0]?.userId)))
        return false;
      if (
        new Set(ops.map((op) => op.opId)).size !== ops.length ||
        ops.some((op) => records.has(op.opId))
      )
        throw new Error('Operation already exists');
      const copies = structuredClone(ops);
      for (const op of copies) records.set(op.opId, op);
      return true;
    },
    async replaceRefused(refused, replacements) {
      if (!sameRefusals(refused, records)) return false;
      if (replacements.some((op) => records.has(op.opId)))
        throw new Error('Operation already exists');
      for (const op of structuredClone(replacements)) records.set(op.opId, op);
      for (const op of refused) records.delete(op.opId);
      return true;
    },
    async update(opId, change) {
      const current = records.get(opId);
      if (!current) return undefined;
      const next = change(structuredClone(current));
      if (!next) return structuredClone(current);
      const stored = guardTerminal(current, next);
      records.set(opId, structuredClone(stored));
      return structuredClone(stored);
    },
    async observeBundle(generatedAt, seenAt) {
      if (generatedAt > (bundle?.generatedAt ?? 0)) bundle = { generatedAt, seenAt };
    },
    async claimKick(opId, kickedAt, ready) {
      const op = kickable([...records.values()], opId, (group) =>
        ready(group, bundle?.seenAt ?? 0),
      );
      if (!op) return false;
      records.set(opId, { ...op, kickedAt });
      return true;
    },
    async remove(ids) {
      for (const id of ids) records.delete(id);
    },
  };
}
