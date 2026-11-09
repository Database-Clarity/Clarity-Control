import { incomingAliases, publishableHash, type Aliases } from '@clarity/core';
import type { FingerprintRequest, FingerprintResponse } from './fingerprints';

// Content keys survive bundle refreshes. Keep this regenerable cache bounded and in memory.
const cache = new Map<string, Promise<string>>();
const noAliases: Aliases = {};
const aliasSnapshots = new Map<number, Aliases>();
self.onmessage = async ({ data }: MessageEvent<FingerprintRequest>) => {
  try {
    if (data.aliases) aliasSnapshots.set(data.aliasId, data.aliases);
    const aliases = aliasSnapshots.get(data.aliasId);
    if (!aliases) throw new Error('Missing alias snapshot');
    const hash = (tooltip: FingerprintRequest['tooltips'][number], withAliases: Aliases) => {
      const key = JSON.stringify([tooltip, incomingAliases(tooltip.hash, withAliases)]);
      let value = cache.get(key);
      if (!value) {
        value = publishableHash(tooltip, withAliases);
        cache.set(key, value);
        void value.catch(() => cache.delete(key));
        if (cache.size > 4096) cache.delete(cache.keys().next().value!);
      }
      return value;
    };
    const hashes = await Promise.all(data.tooltips.map((tooltip) => hash(tooltip, aliases)));
    // Only tooltips with an incoming alias differ without it: the rest reuse their digest.
    const bare = await Promise.all(
      data.tooltips.map((tooltip, index) =>
        incomingAliases(tooltip.hash, aliases).length
          ? hash(tooltip, noAliases)
          : Promise.resolve(hashes[index]),
      ),
    );
    self.postMessage({ id: data.id, hashes, bare } satisfies FingerprintResponse);
  } catch (reason) {
    self.postMessage({ id: data.id, error: String(reason) } satisfies FingerprintResponse);
  }
};
