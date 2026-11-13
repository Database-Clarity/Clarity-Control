// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { findConflictBlocks, type Tooltip } from '@clarity/core';
import { createIndexedDbStorage, userDraftKey } from '../services/draftStorage';
import { acceptSaved } from '../services/save/drafts';
import { editorData } from '../services/save/fixtures.testSupport';
import { scheduledEnabled } from '../services/scheduled/flag';
import { useConflictStore } from './conflicts';
import { useDataStore } from './data';
import { useDraftStore } from './drafts';

// Spec R6 / I6: with the scheduled-changes switch OFF (the production default), nothing reads or
// writes the batch namespace and no storage key changes. The batch module must never even load.
const loaded = vi.hoisted(() => ({ batchModule: false }));
vi.mock('../services/scheduled/batchDrafts', () => {
  loaded.batchModule = true;
  return {};
});

/** Map-backed Web Storage (Node's own localStorage shadows jsdom's without a backing file). */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}
vi.stubGlobal('localStorage', memoryStorage());
vi.stubGlobal('sessionStorage', memoryStorage());

const touched = new Set<string>();
const announced: unknown[] = [];
const restore: (() => void)[] = [];
beforeAll(() => {
  for (const method of ['get', 'put', 'delete', 'add'] as const) {
    const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest;
    IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: unknown[]) {
      const key = method === 'put' || method === 'add' ? args[1] : args[0];
      touched.add(String(key));
      return original.apply(this, args);
    } as never;
    restore.push(() => void (IDBObjectStore.prototype[method] = original as never));
  }
  const post = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, message: unknown) {
    announced.push(message);
    return post.call(this, message);
  };
  restore.push(() => void (BroadcastChannel.prototype.postMessage = post));
});
afterAll(() => restore.forEach((undo) => undo()));

async function snapshot() {
  const idb = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const open = indexedDB.open('clarity-editor-v2', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const store = db.transaction('drafts', 'readonly').objectStore('drafts');
      const keys = store.getAllKeys();
      const values = store.getAll();
      values.onsuccess = () => {
        db.close();
        resolve(
          Object.fromEntries(
            keys.result.map((key, index) => [String(key), JSON.stringify(values.result[index])]),
          ),
        );
      };
    };
  });
  const web = (storage: Storage) =>
    Object.fromEntries(
      Array.from({ length: storage.length }, (_, index) => storage.key(index)!).map((key) => [
        key,
        storage.getItem(key),
      ]),
    );
  return {
    databases: (await indexedDB.databases()).map((db) => db.name).sort(),
    idb,
    local: web(localStorage),
    session: web(sessionStorage),
  };
}

const entry = (text: string) => ({ text, updatedAt: '2026-01-01T10:00:00.000Z', updatedBy: 'a' });
const tooltip = (en: string, extra: Partial<Tooltip> = {}): Tooltip => ({
  hash: 123,
  text: { en: entry(en) },
  associated: [],
  ...extra,
});

it('flag OFF: a full Current edit, conflict, and save flow leaves every storage key unchanged', async () => {
  expect(scheduledEnabled()).toBe(false);
  const user = 'flag-off-user';
  const base = tooltip('top\nshared\nbottom');
  const head = tooltip('top\ntheirs\nbottom');
  const unrelated = tooltip('kept', { hash: 999 });
  // An existing device: one unrelated Current draft stored before this session.
  const seed = createIndexedDbStorage().forUser!(user);
  await seed.read();
  await seed.write({
    999: { base: unrelated, next: { ...unrelated, text: { en: entry('mine') } } },
  });
  useDataStore.setState({
    data: {
      ...editorData(),
      bundle: { ...editorData().bundle, tooltips: { 123: base, 999: unrelated } },
    },
  });
  const stopConflicts = useConflictStore.getState().start();
  const before = await snapshot();
  touched.clear();
  announced.length = 0;

  await useDraftStore.getState().activate(user);
  useDraftStore.getState().edit(base, 'en', 'top\nmine\nbottom', 'alice');
  await useDraftStore.getState().flush();
  // The save is refused: someone saved the same line meanwhile. Resolve inline, then save.
  const begun = useConflictStore
    .getState()
    .begin([
      {
        hash: 123,
        base,
        head,
        next: useDraftStore.getState().drafts[123].next,
        fields: ['text.en'],
      },
    ]);
  expect(begun.markers).toBe(1);
  await useDraftStore.getState().flush();
  expect(findConflictBlocks(useDraftStore.getState().drafts[123].next.text.en!.text)).toHaveLength(
    1,
  );
  useDraftStore.getState().edit(head, 'en', 'top\nmine and theirs\nbottom', 'alice');
  await useDraftStore.getState().flush();
  const submitted = { 123: useDraftStore.getState().drafts[123] };
  acceptSaved(submitted, [submitted[123].next], 'saved-commit');
  await useDraftStore.getState().flush();
  expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['999']);
  // Another account and back (the account switch path), then sign out.
  await useDraftStore.getState().activate('flag-off-other');
  await useDraftStore.getState().activate(user);
  await useDraftStore.getState().activate(null);
  await useDraftStore.getState().flush();
  stopConflicts();

  const after = await snapshot();
  expect(after).toEqual(before);
  // Only Current buckets were read or written, and only Current keys were announced.
  expect([...touched].sort()).toEqual(
    ['tooltips', userDraftKey('flag-off-other'), userDraftKey(user)].sort(),
  );
  for (const message of announced)
    expect((message as { key: string }).key).toBe(userDraftKey(user));
  expect(JSON.stringify(after).includes('batch')).toBe(false);
  expect(loaded.batchModule).toBe(false);
});
