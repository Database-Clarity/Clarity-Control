import type { CompendiumCell } from '@clarity/core';
import { projectCompendiumDiff } from './compendiumDiffProjection';

self.onmessage = (
  event: MessageEvent<{ id: number; before: CompendiumCell; after: CompendiumCell }>,
) => {
  const { id, before, after } = event.data;
  self.postMessage({ id, lines: projectCompendiumDiff(before, after) });
};
