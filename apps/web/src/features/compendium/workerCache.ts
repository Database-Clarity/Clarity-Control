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
/** Stored results kept across datasets/builds: values, their encoded replies, and identities. */
const storedLimit = 12;
const memory = new Map<string, unknown>();
function remember<T>(key: string, value: T): T {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > 8) memory.delete(memory.keys().next().value!);
  return value;
}

/** A remembered or stored result, or undefined. Storage failures read as a miss. */
export async function cachedValue<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T;
  // A write still waiting for a quiet worker is the newest copy of its key.
  if (pendingWrites.has(key)) return remember(key, pendingWrites.get(key) as T);
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const request = db!.transaction('results').objectStore('results').get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
    if (value !== undefined) return remember(key, value);
  } catch {
    /* Private browsing/storage policy: compute the same answer in memory. */
  } finally {
    db?.close();
  }
  return undefined;
}

/** Keep a result in worker memory now and store an optional copy once the worker is quiet. */
export function storeValue<T>(key: string, value: T): T {
  remember(key, value);
  pendingWrites.delete(key);
  pendingWrites.set(key, value);
  scheduleWrites();
  return value;
}

export async function cachedComputation<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const cached = await cachedValue<T>(key);
  if (cached !== undefined) return cached;
  return storeValue(key, await compute());
}

// IndexedDB's put clones the whole value synchronously on this thread. Cloning a catalog
// while replies were still encoding delayed the open by the clone, so writes wait until no
// request has run for a quiet period, go one key per task, and stop when a request arrives.
const pendingWrites = new Map<string, unknown>();
const quietMs = 1000;
let activeWork = 0;
let writing = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleWrites() {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  if (!pendingWrites.size || activeWork || writing) return;
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    void writePending(() => activeWork > 0);
  }, quietMs);
}
async function writePending(stop: () => boolean) {
  if (writing) return;
  writing = true;
  try {
    while (pendingWrites.size && !stop()) {
      const [key, value] = pendingWrites.entries().next().value!;
      pendingWrites.delete(key);
      await persist(key, value);
    }
  } finally {
    writing = false;
    scheduleWrites();
  }
}
/** Hold stored writes while a request runs; they resume after the next quiet period. */
export function cacheWriteActivity<T>(work: Promise<T>): Promise<T> {
  activeWork++;
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  const done = () => {
    activeWork--;
    scheduleWrites();
  };
  work.then(done, done);
  return work;
}
/** Write every pending result now (tests, and callers about to hand storage to a new owner). */
export function flushCacheWrites() {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  return writePending(() => false);
}

async function persist(key: string, value: unknown) {
  let db: IDBDatabase | undefined;
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
          for (const old of ages.sort((a, b) => b.at - a.at).slice(storedLimit)) {
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
}
export async function contentHash(value: unknown) {
  return bytesHash(new TextEncoder().encode(JSON.stringify(value)));
}
/** SHA-256 of bytes already in hand: no JSON serialization of a parsed graph. */
export async function bytesHash(bytes: BufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
