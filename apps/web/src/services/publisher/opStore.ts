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
  /** Numeric account id the body was confirmed under; another account never resumes it. */
  userId: string;
  createdAt: number;
  hashes: number[];
  expected: Record<string, string>;
  /** The pushed marker each hash had when confirmed (null = none), for the acknowledgment overlay. */
  previous: Record<string, string | null>;
  status: OpStatus;
  /** When the Worker first said "queued"; drives the waiting threshold and the auto-kick. */
  acceptedAt?: number;
  kickedAt?: number;
  autoKicked?: boolean;
  polledAt?: number;
  /** Plain-language reason for `failed`/`stale`/`rejected` that originates in the client. */
  error?: string;
  updatedAt: number;
  dismissed?: boolean;
}

export interface OpStore {
  list(userId: string): Promise<PublishOp[]>;
  /** Insert-only: an existing opId is never replaced. */
  add(op: PublishOp): Promise<void>;
  /** All chunks commit atomically before any send. */
  addMany(ops: PublishOp[]): Promise<void>;
  /**
   * Atomic read-modify-write (one IndexedDB transaction, so two tabs cannot both win a claim). The
   * callback returns the changed record or undefined for "leave it". A terminal status is never
   * overwritten by a different one. Resolves with the stored record, or undefined if missing.
   */
  update(
    opId: string,
    change: (op: PublishOp) => PublishOp | undefined,
  ): Promise<PublishOp | undefined>;
  remove(opIds: string[]): Promise<void>;
}

const dbName = 'clarity-publisher';
const storeName = 'operations';

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
            ((event.target as IDBRequest<PublishOp[]>).result ?? []).filter(
              (op) => op.userId === userId,
            ),
          );
      }),
    add: (op) =>
      run<void>('readwrite', (store) => {
        // add() fails (ConstraintError, aborting the transaction) rather than replacing an opId.
        store.add(op);
      }),
    addMany: (ops) =>
      run<void>('readwrite', (store) => {
        for (const op of ops) store.add(op);
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
    remove: (opIds) =>
      run<void>('readwrite', (store) => {
        for (const id of opIds) store.delete(id);
      }),
  };
}

/** Identity fields are immutable; a terminal status sticks. Shared by every store implementation. */
export function guardTerminal(current: PublishOp, next: PublishOp): PublishOp {
  const merged: PublishOp = {
    ...next,
    opId: current.opId,
    groupId: current.groupId,
    groupSize: current.groupSize,
    userId: current.userId,
    createdAt: current.createdAt,
    hashes: current.hashes,
    expected: current.expected,
    previous: current.previous,
  };
  if (isTerminal(current.status) && next.status !== current.status) {
    merged.status = current.status;
    merged.error = current.error;
  }
  return merged;
}

/** In-memory store: tests, and the shape the IndexedDB one must keep. */
export function createMemoryOpStore(): OpStore & { records: Map<string, PublishOp> } {
  const records = new Map<string, PublishOp>();
  return {
    records,
    async list(userId) {
      return [...records.values()]
        .filter((op) => op.userId === userId)
        .map((op) => structuredClone(op));
    },
    async add(op) {
      if (records.has(op.opId)) throw new Error('Operation already exists');
      records.set(op.opId, structuredClone(op));
    },
    async addMany(ops) {
      if (
        new Set(ops.map((op) => op.opId)).size !== ops.length ||
        ops.some((op) => records.has(op.opId))
      )
        throw new Error('Operation already exists');
      const copies = structuredClone(ops);
      for (const op of copies) records.set(op.opId, op);
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
    async remove(ids) {
      for (const id of ids) records.delete(id);
    },
  };
}
