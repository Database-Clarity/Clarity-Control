import { incomingAliases, publishableHash, type Aliases, type Tooltip } from '@clarity/core';

export interface FingerprintRequest {
  id: number;
  tooltips: Tooltip[];
  aliasId: number;
  aliases?: Aliases;
}
export interface FingerprintResponse {
  id: number;
  hashes?: string[];
  /**
   * The digest with incoming aliases left out, parallel to `hashes`. Equal to the hash when the
   * tooltip has no incoming alias; a saved tooltip whose only change is that marker is a leftover
   * of the alias migration, not a content change.
   */
  bare?: string[];
  error?: string;
}
export interface FingerprintDigest {
  hash: string;
  bare: string;
}

// Store snapshots are immutable. Alias identity is part of the key: a new alias, a chain
// change, or a fallback timestamp change must invalidate the reviewed fingerprint.
const revisions = new WeakMap<Tooltip, WeakMap<Aliases, Promise<FingerprintDigest>>>();
let worker: Worker | undefined;
let nextId = 0;
let aliasIds = new WeakMap<Aliases, number>();
let nextAliasId = 0;
const requests = new Map<
  number,
  { resolve(digests: FingerprintDigest[]): void; reject(error: Error): void }
>();

export function prepareFingerprintWorker(): void {
  if (typeof Worker === 'undefined') return;
  if (!worker) {
    worker = new Worker(new URL('./fingerprints.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<FingerprintResponse>) => {
      const request = requests.get(data.id);
      requests.delete(data.id);
      if (data.hashes)
        request?.resolve(
          data.hashes.map((hash, index) => ({ hash, bare: data.bare?.[index] ?? hash })),
        );
      else request?.reject(new Error(data.error ?? 'Fingerprint computation failed'));
    };
    worker.onerror = (event) => {
      for (const request of requests.values()) request.reject(new Error(event.message));
      requests.clear();
      worker?.terminate();
      worker = undefined;
      aliasIds = new WeakMap();
    };
  }
}

const noAliases: Aliases = {};
async function digest(tooltip: Tooltip, aliases: Aliases): Promise<FingerprintDigest> {
  const hash = await publishableHash(tooltip, aliases);
  return { hash, bare: incomingAliases(tooltip.hash, aliases).length ? await publishableHash(tooltip, noAliases) : hash };
}

function batch(tooltips: Tooltip[], aliases: Aliases): Promise<FingerprintDigest[]> {
  if (typeof Worker === 'undefined') return Promise.all(tooltips.map((t) => digest(t, aliases)));
  prepareFingerprintWorker();
  const id = ++nextId;
  let aliasId = aliasIds.get(aliases);
  const initialize = aliasId === undefined;
  if (aliasId === undefined) {
    aliasId = ++nextAliasId;
    aliasIds.set(aliases, aliasId);
  }
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    try {
      worker!.postMessage({
        id,
        // Exactly the fields core's publishableHash and English fallback read. Complete
        // records were validated on load; snapshots and archive metadata aren't hash input.
        tooltips: tooltips.map(({ hash, text, associated, custom }) => ({
          hash,
          text,
          associated,
          custom,
        })),
        aliasId,
        ...(initialize ? { aliases } : {}),
      } satisfies FingerprintRequest);
    } catch (reason) {
      requests.delete(id);
      if (initialize) aliasIds.delete(aliases);
      reject(reason);
    }
  });
}

/** Clone and hash only changed revisions, in small batches, away from the input task. */
export async function fingerprints(tooltips: Tooltip[], aliases: Aliases): Promise<string[]> {
  return (await fingerprintDigests(tooltips, aliases)).map(({ hash }) => hash);
}

/** Each tooltip's digest and its alias-free digest, from one worker pass. */
export async function fingerprintDigests(
  tooltips: Tooltip[],
  aliases: Aliases,
): Promise<FingerprintDigest[]> {
  const results: Promise<FingerprintDigest>[] = [];
  for (let start = 0; start < tooltips.length; start += 64) {
    const slice = tooltips.slice(start, start + 64);
    const changed = slice.filter((tooltip) => !revisions.get(tooltip)?.has(aliases));
    if (changed.length) {
      const scheduler = (
        globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }
      ).scheduler;
      if (scheduler) await scheduler.yield();
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // Another request may have filled these revisions while we yielded.
      const missing = changed.filter((tooltip) => !revisions.get(tooltip)?.has(aliases));
      if (missing.length) {
        const pending = batch(missing, aliases);
        missing.forEach((tooltip, index) => {
          let cache = revisions.get(tooltip);
          if (!cache) revisions.set(tooltip, (cache = new WeakMap()));
          const value = pending.then((digests) => digests[index]!);
          cache.set(aliases, value);
          void value.catch(() => cache!.delete(aliases));
        });
      }
    }
    results.push(...slice.map((tooltip) => revisions.get(tooltip)!.get(aliases)!));
  }
  return Promise.all(results);
}
