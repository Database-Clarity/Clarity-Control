import { tooltipSchema } from '@clarity/core';
import { z } from 'zod';

export const draftsSchema = z
  .record(
    z.string(),
    z.object({
      base: tooltipSchema,
      next: tooltipSchema,
    }),
  )
  .refine(
    (drafts) =>
      Object.entries(drafts).every(
        ([key, { base, next }]) => key === String(base.hash) && base.hash === next.hash,
      ),
    'Draft keys and tooltip hashes must match',
  );
export type Drafts = z.infer<typeof draftsSchema>;
export interface DraftStorage {
  read(): Promise<Drafts>;
  write(drafts: Drafts): Promise<void>;
  /**
   * Storage for one account's drafts. The storage itself is the unowned bucket: drafts made
   * signed-out, plus every draft saved before drafts were tied to accounts. Optional so that
   * single-bucket test doubles keep working.
   */
  forUser?(userId: string): DraftStorage;
}

const unownedKey = 'tooltips';
export const userDraftKey = (userId: string) => `${unownedKey}:user:${userId}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clarity-editor-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Draft storage upgrade blocked. Close other editor tabs.'));
  });
}

export function createIndexedDbStorage(key = unownedKey): DraftStorage {
  let expected: string | undefined;
  const users = new Map<string, DraftStorage>();
  return {
    ...(key === unownedKey
      ? {
          forUser(userId: string) {
            let storage = users.get(userId);
            if (!storage) {
              storage = createIndexedDbStorage(userDraftKey(userId));
              users.set(userId, storage);
            }
            return storage;
          },
        }
      : {}),
    async read() {
      const db = await openDatabase();
      try {
        return await new Promise<Drafts>((resolve, reject) => {
          const transaction = db.transaction('drafts', 'readonly');
          const request = transaction.objectStore('drafts').get(key);
          transaction.oncomplete = () => {
            const parsed = draftsSchema.safeParse(request.result ?? {});
            if (parsed.success) {
              expected = JSON.stringify(request.result ?? {});
              resolve(parsed.data);
            } else reject(new Error(`Stored drafts are invalid: ${parsed.error.message}`));
          };
          transaction.onabort = () => reject(transaction.error ?? new Error('Draft read aborted'));
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
    async write(drafts) {
      const db = await openDatabase();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('drafts', 'readwrite');
          const store = transaction.objectStore('drafts');
          const request = store.get(key);
          let conflict = false;
          request.onsuccess = () => {
            if (expected === undefined || JSON.stringify(request.result ?? {}) !== expected) {
              conflict = true;
              transaction.abort();
              return;
            }
            store.put(drafts, key);
          };
          transaction.oncomplete = () => {
            expected = JSON.stringify(drafts);
            resolve();
          };
          transaction.onabort = () =>
            reject(
              conflict
                ? new Error(
                    'Another tab changed local drafts. Keep this tab open; recover the other tab before reloading.',
                  )
                : (transaction.error ?? new Error('Draft write aborted')),
            );
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

export const draftStorage = createIndexedDbStorage();
