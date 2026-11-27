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

  it(`${name}: chunks are inserted atomically, including duplicate failures`, async () => {
    await store.addMany([op('existing')]);
    await expect(store.addMany([op('new'), op('existing')])).rejects.toThrow();
    expect((await store.list('1')).map((entry) => entry.opId)).toEqual(['existing']);
    await store.addMany([op('A', { groupId: 'A' }), op('B', { groupId: 'A' })]);
    expect(await store.list('1')).toHaveLength(3);
  });

  it(`${name}: two tabs cannot store the same selection`, async () => {
    const busy = (stored: PublishOp[]) => stored.some(({ hashes }) => hashes.includes(10));
    const won = await Promise.all([
      store.addMany([op('A')], busy),
      store.addMany([op('B')], busy),
      store.addMany([op('C', { userId: '2' })], busy),
    ]);
    expect(won).toEqual([true, false, true]);
    expect((await store.list('1')).map(({ opId }) => opId)).toEqual(['A']);
  });

  it(`${name}: two recovery claims can replace the same refused round only once`, async () => {
    const first = op('A', { groupId: 'A', status: 'rejected', refusal: 'Missing export' });
    const second = op('B', { groupId: 'A', status: 'rejected', refusal: 'Missing import' });
    const done = op('C', { groupId: 'A', status: 'done' });
    await store.addMany([first, second, done]);
    const refused = [first, second];
    const won = await Promise.all([
      store.replaceRefused(refused, [op('D', { groupId: 'A' })]),
      store.replaceRefused(refused, [op('E', { groupId: 'A' })]),
    ]);
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await store.list('1')).map(({ opId }) => opId).sort()).toEqual([
      'C',
      won[0] ? 'D' : 'E',
    ]);
  });

  it(`${name}: persists per account and never replaces an opId`, async () => {
    await store.addMany([op('A')]);
    await store.addMany([op('B', { userId: '2' })]);
    expect((await store.list('1')).map((o) => o.opId)).toEqual(['A']);
    expect((await store.list('2')).map((o) => o.opId)).toEqual(['B']);
    await expect(store.addMany([op('A', { hashes: [99] })])).rejects.toThrow();
    expect((await store.list('1'))[0]!.hashes).toEqual([10]);
  });

  it(`${name}: update is atomic, keeps identity fields and sticks to a terminal status`, async () => {
    await store.addMany([op('A')]);
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
    await store.addMany([
      op('A', { groupId: 'A', status: 'pending' }),
      op('B', { groupId: 'A', status: 'pending' }),
    ]);
    const claim = (id: string) =>
      store.claimKick(id, 100, (members) =>
        members.every(({ kickedAt }) => kickedAt === undefined),
      );
    const results = await Promise.all([claim('A'), claim('B')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.update('A', (o) => ({ ...o, status: 'done' }));
    expect(await store.claimKick('A', 200, () => true)).toBe(false);
  });

  it(`${name}: the kick claim sees the newest bundle without listing it as an operation`, async () => {
    await store.addMany([op('A', { status: 'pending' })]);
    await store.observeBundle(300, 350);
    const reloaded = name === 'IndexedDB' ? make() : store;
    await reloaded.observeBundle(100, 380);
    await reloaded.observeBundle(300, 390);
    expect(await reloaded.list('1')).toEqual([op('A', { status: 'pending' })]);
    expect(await reloaded.claimKick('A', 400, (_, bundleAt) => bundleAt === 350)).toBe(true);
  });
}

it('IndexedDB: a whole request is invisible to a previous-client tab and reads back unchanged', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const store = createIndexedDbOpStore();
  const whole = op('W', { whole: true, hashes: [10, 20] });
  await store.addMany([op('A'), whole]);
  // What the previous client lists: records whose userId is exactly the account id.
  const raw = await new Promise<PublishOp[]>((resolve, reject) => {
    const open = indexedDB.open('clarity-publisher', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction('operations').objectStore('operations').getAll();
      all.onsuccess = () => {
        open.result.close();
        resolve(all.result as PublishOp[]);
      };
    };
  });
  expect(raw.filter(({ userId }) => userId === '1').map(({ opId }) => opId)).toEqual(['A']);
  expect((await store.list('1')).map(({ opId, userId }) => [opId, userId])).toEqual([
    ['A', '1'],
    ['W', '1'],
  ]);
  const updated = await store.update('W', (current) => ({ ...current, status: 'pending' }));
  expect(updated).toMatchObject({ userId: '1', status: 'pending', whole: true });
  expect((await store.list('1')).find(({ opId }) => opId === 'W')?.status).toBe('pending');
});
