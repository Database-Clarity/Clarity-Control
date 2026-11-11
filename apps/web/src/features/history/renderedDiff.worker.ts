import type { MarkupGlobals } from '@clarity/core';
import { renderedDiff } from './renderedDiff';
self.onmessage = (
  event: MessageEvent<{ id: number; before: string; after: string; globals: MarkupGlobals }>,
) => {
  const { id, before, after, globals } = event.data;
  try {
    self.postMessage({ id, result: renderedDiff(before, after, globals) });
  } catch {
    self.postMessage({ id });
  }
};
