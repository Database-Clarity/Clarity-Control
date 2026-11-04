// Optional performance cache only: blocked storage must never affect matching correctness.
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('clarity-compendium-computed-v2', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('results');
      request.result.createObjectStore('access');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function cachedComputation<T>(key: string, compute: () => Promise<T>): Promise<T> {
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const request = db!.transaction('results').objectStore('results').get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
    if (value !== undefined) return value;
  } catch {
    /* Private browsing/storage policy: compute the same answer in memory. */
  } finally {
    db?.close();
  }
  const value = await compute();
  try {
    db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(['results', 'access'], 'readwrite');
      tx.objectStore('results').put(value, key);
      const access = tx.objectStore('access');
      access.put(Date.now(), key);
      const ages: { key: IDBValidKey; at: number }[] = [];
      const cursor = access.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (entry) {
          ages.push({ key: entry.key, at: entry.value as number });
          entry.continue();
        } else {
          // Keep storage bounded across changed datasets/builds and local review decisions.
          for (const old of ages.sort((a, b) => b.at - a.at).slice(6)) {
            if (old.key === key) continue;
            access.delete(old.key);
            tx.objectStore('results').delete(old.key);
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* Cache writes are never required. */
  } finally {
    db?.close();
  }
  return value;
}
export async function contentHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
