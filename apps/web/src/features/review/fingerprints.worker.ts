import { incomingAliases, publishableHash, type Aliases } from '@clarity/core';
import type { FingerprintRequest, FingerprintResponse } from './fingerprints';

// Content keys survive bundle refreshes. Keep this regenerable cache bounded and in memory.
const cache = new Map<string, Promise<string>>();
const aliasSnapshots = new Map<number, Aliases>();
self.onmessage = async ({ data }: MessageEvent<FingerprintRequest>) => {
  try {
    if (data.aliases) aliasSnapshots.set(data.aliasId, data.aliases);
    const aliases = aliasSnapshots.get(data.aliasId);
    if (!aliases) throw new Error('Missing alias snapshot');
    const hashes = await Promise.all(
      data.tooltips.map((tooltip) => {
        const key = JSON.stringify([tooltip, incomingAliases(tooltip.hash, aliases)]);
        let value = cache.get(key);
        if (!value) {
          value = publishableHash(tooltip, aliases);
          cache.set(key, value);
          void value.catch(() => cache.delete(key));
          if (cache.size > 4096) cache.delete(cache.keys().next().value!);
        }
        return value;
      }),
    );
    self.postMessage({ id: data.id, hashes } satisfies FingerprintResponse);
  } catch (reason) {
    self.postMessage({ id: data.id, error: String(reason) } satisfies FingerprintResponse);
  }
};
