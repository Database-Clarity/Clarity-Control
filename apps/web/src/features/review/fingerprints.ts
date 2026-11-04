import { publishableHash, type Aliases, type Tooltip } from '@clarity/core';

export interface FingerprintRequest {
  id: number;
  tooltips: Tooltip[];
  aliasId: number;
  aliases?: Aliases;
}
export interface FingerprintResponse {
  id: number;
  hashes?: string[];
  error?: string;
}

// Store snapshots are immutable. Alias identity is part of the key: a new alias, a chain
// change, or a fallback timestamp change must invalidate the reviewed fingerprint.
const revisions = new WeakMap<Tooltip, WeakMap<Aliases, Promise<string>>>();
let worker: Worker | undefined;
let nextId = 0;
let aliasIds = new WeakMap<Aliases, number>();
let nextAliasId = 0;
const requests = new Map<number, { resolve(hashes: string[]): void; reject(error: Error): void }>();

function batch(tooltips: Tooltip[], aliases: Aliases): Promise<string[]> {
  if (typeof Worker === 'undefined')
    return Promise.all(tooltips.map((t) => publishableHash(t, aliases)));
  if (!worker) {
    worker = new Worker(new URL('./fingerprints.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<FingerprintResponse>) => {
      const request = requests.get(data.id);
      requests.delete(data.id);
      if (data.hashes) request?.resolve(data.hashes);
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
        tooltips,
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
  const results: Promise<string>[] = [];
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
          const value = pending.then((hashes) => hashes[index]!);
          cache.set(aliases, value);
          void value.catch(() => cache!.delete(aliases));
        });
      }
    }
    results.push(...slice.map((tooltip) => revisions.get(tooltip)!.get(aliases)!));
  }
  return Promise.all(results);
}
