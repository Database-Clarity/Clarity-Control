import type { MarkupGlobals } from '@clarity/core';
import { renderedDiff } from './renderedDiff';
import { analyzeSourceOnly } from './sourceOnlyChanges';
self.onmessage = (
  event: MessageEvent<{ id: number; before: string; after: string; globals: MarkupGlobals }>,
) => {
  const { id, before, after, globals } = event.data;
  try {
    const result = renderedDiff(before, after, globals);
    self.postMessage({
      id,
      // Accounting reads the same final diff the user sees, never a separate render.
      result: { ...result, sourceAnalysis: analyzeSourceOnly(before, after, globals, result) },
    });
  } catch {
    self.postMessage({ id });
  }
};
