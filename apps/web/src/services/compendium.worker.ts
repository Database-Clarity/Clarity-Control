import { compendiumDataSchema, isTrackedCompendiumTab } from '@clarity/core';
import { cachedComputation, contentHash } from '../features/compendium/workerCache';
import { sendWorkerResult } from '../features/compendium/workerReplies';
self.onmessage = async ({ data }: MessageEvent<{ url: string }>) => {
  try {
    const response = await fetch(data.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Compendium HTTP ${response.status}`);
    const raw: unknown = await response.json();
    const key = `source-v1:${await contentHash(raw)}`;
    const value = await cachedComputation(key, async () => {
      const source = compendiumDataSchema.parse(raw);
      return { ...source, tabs: source.tabs.filter((tab) => isTrackedCompendiumTab(tab.name)) };
    });
    sendWorkerResult((reply) => self.postMessage(reply), 0, value);
  } catch (error) {
    self.postMessage({ id: 0, error: error instanceof Error ? error.message : String(error) });
  }
};
