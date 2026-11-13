import { compendiumDataSchema, isTrackedCompendiumTab } from '@clarity/core';
import { bytesHash, cachedComputation } from '../features/compendium/workerCache';

/**
 * Runs only in the worker that will retain this source for matching. The key names the exact
 * published bytes (hashed as received, never re-serialized); `read` parses or restores them.
 */
export async function fetchCompendiumSource(url: string) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Compendium HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const key = `source-v2:${await bytesHash(bytes)}`;
  return {
    key,
    read: () =>
      cachedComputation(key, async () => {
        const source = compendiumDataSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        return { ...source, tabs: source.tabs.filter((tab) => isTrackedCompendiumTab(tab.name)) };
      }),
  };
}
