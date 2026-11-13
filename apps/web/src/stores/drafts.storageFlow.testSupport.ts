import { expect } from 'vitest';
import { findConflictBlocks, type Tooltip } from '@clarity/core';
import { createIndexedDbStorage } from '../services/draftStorage';
import type { acceptSaved as AcceptSaved } from '../services/save/drafts';
import { editorData } from '../services/save/fixtures.testSupport';
import type { useConflictStore as ConflictStore } from './conflicts';
import type { useDataStore as DataStore } from './data';
import type { useDraftStore as DraftStore } from './drafts';

/**
 * Shared by drafts.flagOff.test.ts and drafts.flagOn.test.ts (spec R6, I6): a full Current
 * edit, conflict, and save flow, with every IndexedDB key and channel message recorded and the
 * browser storage snapshotted around it. Callers run in jsdom with fake-indexeddb loaded.
 */
/** Map-backed Web Storage (Node's own localStorage shadows jsdom's without a backing file). */
export function memoryStorage(): Storage {
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
export const touched = new Set<string>();
export const announced: unknown[] = [];
const restore: (() => void)[] = [];
/** Records every IndexedDB key read or written and every channel message. Returns the undo. */
export function spyOnStorage(): () => void {
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
  return () => restore.splice(0).forEach((undo) => undo());
}

export async function snapshot() {
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

export interface FlowModules {
  useDraftStore: typeof DraftStore;
  useConflictStore: typeof ConflictStore;
  useDataStore: typeof DataStore;
  acceptSaved: typeof AcceptSaved;
}

/** Runs the flow as `user` (and briefly `other`); returns storage before and after. */
export async function runCurrentFlow(
  { useDraftStore, useConflictStore, useDataStore, acceptSaved }: FlowModules,
  user: string,
  other: string,
) {
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
  const begun = useConflictStore.getState().begin([
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
  await useDraftStore.getState().activate(other);
  await useDraftStore.getState().activate(user);
  await useDraftStore.getState().activate(null);
  await useDraftStore.getState().flush();
  stopConflicts();

  return { before, after: await snapshot() };
}
