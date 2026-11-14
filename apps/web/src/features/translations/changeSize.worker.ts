import { tooltipSchema } from '@clarity/core';
import { z } from 'zod';
import { changedWords, changeKey, type ChangeRequest } from './changeSize';
import { findTranslationSource } from './source';

const historySchema = z.object({ commits: z.array(z.object({ commit: z.string() })) });
const versionSchema = z.object({ tooltip: tooltipSchema });

function cache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('translation-change-sizes-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sizes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function read(db: IDBDatabase, key: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('sizes').objectStore('sizes').get(key);
    request.onsuccess = () =>
      resolve(typeof request.result === 'number' ? request.result : undefined);
    request.onerror = () => reject(request.error);
  });
}

self.onmessage = async ({
  data,
}: MessageEvent<ChangeRequest & { url: string; headers: Record<string, string> }>) => {
  let db: IDBDatabase | undefined;
  try {
    db = await cache().catch(() => undefined);
    const key = changeKey(data);
    const cached = db ? await read(db, key).catch(() => undefined) : undefined;
    if (cached !== undefined) {
      self.postMessage({ count: cached });
      return;
    }
    async function request(path: string) {
      const response = await fetch(`${data.url}${path}`, {
        credentials: 'omit',
        headers: data.headers,
      });
      if (!response.ok) throw new Error(`History unavailable (HTTP ${response.status})`);
      return response.json();
    }
    const source = await findTranslationSource(data.hash, data.sourceUpdatedAt, {
      getHistory: async (hash, page) =>
        historySchema.parse(await request(`/history/${hash}?page=${page}`)),
      getVersion: async (hash, commit) =>
        versionSchema.parse(await request(`/history/${hash}?commit=${encodeURIComponent(commit)}`)),
    });
    if (source.kind !== 'found') {
      self.postMessage({ error: source.reason });
      return;
    }
    const count = changedWords(source.text, data.current);
    if (db) {
      // The caller terminates this worker on its reply, so commit before posting the result.
      await new Promise<void>((resolve, reject) => {
        const transaction = db!.transaction('sizes', 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
        const store = transaction.objectStore('sizes');
        store.put(count, key);
        const keys = store.getAllKeys();
        keys.onsuccess = () =>
          keys.result
            .slice(0, Math.max(0, keys.result.length - 1000))
            .forEach((old) => store.delete(old));
      }).catch(() => {});
    }
    self.postMessage({ count });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : 'History unavailable' });
  } finally {
    db?.close();
  }
};
