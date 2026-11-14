import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Each test imports a fresh module whose quiet-write timer would otherwise outlive the test and
// write into the next test's IndexedDB stub. fake-indexeddb schedules with setImmediate, so only
// the worker's timer is faked; useRealTimers drops any write a test left pending.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('publishes computed results even when the optional disk write never opens', async () => {
  const factory = new IDBFactory();
  let opens = 0;
  vi.stubGlobal('indexedDB', {
    open(name: string, version: number) {
      return ++opens === 1 ? factory.open(name, version) : ({} as IDBOpenDBRequest);
    },
  });
  const { cachedComputation } = await import('./workerCache');
  const result = { matches: new Map([[1, 'source']]) };
  const compute = vi.fn(async () => result);
  expect(await cachedComputation('pending-write', compute)).toBe(result);
  expect(await cachedComputation('pending-write', compute)).toBe(result);
  expect(compute).toHaveBeenCalledTimes(1);
});

it('reuses persisted content after worker memory is replaced', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const before = await import('./workerCache');
  const result = { matches: new Map([[2, { name: 'Styled source', bold: true }]]) };
  expect(await before.cachedComputation('content-hash', async () => result)).toBe(result);
  // Resolves only after the write transaction has committed.
  await before.flushCacheWrites();
  vi.resetModules();
  const after = await import('./workerCache');
  const compute = vi.fn(async () => ({ matches: new Map() }));
  expect(await after.cachedComputation('content-hash', compute)).toEqual(result);
  expect(compute).not.toHaveBeenCalled();
});

it('computes without storage and never caches a rejected computation', async () => {
  vi.stubGlobal('indexedDB', {
    open() {
      throw new Error('Storage unavailable');
    },
  });
  const { cachedComputation } = await import('./workerCache');
  await expect(
    cachedComputation('retry', async () => {
      throw new Error('Changed inputs');
    }),
  ).rejects.toThrow('Changed inputs');
  expect(await cachedComputation('retry', async () => 'current evidence')).toBe('current evidence');
});

it('stores a result only after the worker has been quiet, never during a request', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  const { cacheWriteActivity, cachedComputation, cachedValue } = await import('./workerCache');
  let finish!: () => void;
  const request = cacheWriteActivity(new Promise<void>((resolve) => (finish = resolve)));
  const result = { proposals: new Map([[3, 'match']]) };
  expect(await cachedComputation('quiet-write', async () => result)).toBe(result);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put).not.toHaveBeenCalled();
  // A pending write is still the newest copy for readers in this worker.
  expect(await cachedValue('quiet-write')).toBe(result);
  finish();
  await request;
  await vi.advanceTimersByTimeAsync(999);
  expect(put).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(put).toHaveBeenCalled());
});
