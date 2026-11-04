import { compendiumDataSchema, isTrackedCompendiumTab } from '@clarity/core';
import { cachedComputation, contentHash } from '../features/compendium/workerCache';

/** Runs only in the worker that will retain this source for matching. */
export async function fetchCompendiumSource(url: string) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Compendium HTTP ${response.status}`);
  const raw: unknown = await response.json();
  return cachedComputation(`source-v1:${await contentHash(raw)}`, async () => {
    const source = compendiumDataSchema.parse(raw);
    return { ...source, tabs: source.tabs.filter((tab) => isTrackedCompendiumTab(tab.name)) };
  });
}
