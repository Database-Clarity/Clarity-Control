// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import {
  createIndexedDbOpStore,
  createMemoryOpStore,
  type OpStore,
  type PublishOp,
} from './opStore';

const op = (opId: string, patch: Partial<PublishOp> = {}): PublishOp => ({
  opId,
  userId: '1',
  createdAt: 1000,
  hashes: [10],
  expected: { 10: 'a'.repeat(64) },
  previous: { 10: null },
  status: 'created',
  updatedAt: 1000,
  ...patch,
});

for (const [name, make] of [
  ['IndexedDB', () => createIndexedDbOpStore()],
  ['memory', () => createMemoryOpStore()],
] as const) {
  let store: OpStore;
  beforeEach(async () => {
    if (name === 'IndexedDB')
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: new IDBFactory(),
      });
    store = make();
  });

  it(`${name}: persists per account and never replaces an opId`, async () => {
    await store.add(op('A'));
    await store.add(op('B', { userId: '2' }));
    expect((await store.list('1')).map((o) => o.opId)).toEqual(['A']);
    expect((await store.list('2')).map((o) => o.opId)).toEqual(['B']);
    await expect(store.add(op('A', { hashes: [99] }))).rejects.toThrow();
    expect((await store.list('1'))[0]!.hashes).toEqual([10]);
  });

  it(`${name}: update is atomic, keeps identity fields and sticks to a terminal status`, async () => {
    await store.add(op('A'));
    const first = await store.update('A', (o) => ({
      ...o,
      status: 'done' as const,
      hashes: [1, 2],
    }));
    expect(first?.status).toBe('done');
    expect(first?.hashes).toEqual([10]);
    const second = await store.update('A', (o) => ({
      ...o,
      status: 'failed' as const,
      error: 'late',
    }));
    expect(second?.status).toBe('done');
    expect(second?.error).toBeUndefined();
    expect(await store.update('missing', (o) => o)).toBeUndefined();
    // Returning undefined is "leave it": a lost claim changes nothing.
    expect((await store.update('A', () => undefined))?.status).toBe('done');
  });

  it(`${name}: two concurrent claims have one winner`, async () => {
    await store.add(op('A', { status: 'pending' }));
    const claim = () =>
      store.update('A', (o) =>
        o.autoKicked ? undefined : { ...o, autoKicked: true, kickedAt: Math.random() },
      );
    const results = await Promise.all([claim(), claim()]);
    expect(results.filter((r) => r?.autoKicked).length).toBe(2); // both see the final record
    expect(new Set(results.map((r) => r?.kickedAt)).size).toBe(1); // but only one wrote kickedAt
  });
}
