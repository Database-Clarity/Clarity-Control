import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
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
  const originalPut = IDBObjectStore.prototype.put;
  let persisted!: () => void;
  const saved = new Promise<void>((resolve) => {
    persisted = resolve;
  });
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = originalPut.apply(this, args);
    if (this.name === 'results') request.addEventListener('success', persisted);
    return request;
  });
  const before = await import('./workerCache');
  const result = { matches: new Map([[2, { name: 'Styled source', bold: true }]]) };
  expect(await before.cachedComputation('content-hash', async () => result)).toBe(result);
  await saved;
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
