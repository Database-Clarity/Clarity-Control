import type { MarkupGlobals } from '@clarity/core';
import { presentDiff, renderedDiff } from './renderedDiff';
import { analyzeSourceOnly } from './sourceOnlyChanges';
self.onmessage = (
  event: MessageEvent<{ id: number; before: string; after: string; globals: MarkupGlobals }>,
) => {
  const { id, before, after, globals } = event.data;
  try {
    const result = renderedDiff(before, after, globals);
    // Accounting reads the word diff the user sees; presentDiff then only adds
    // marks (merged runs, whole rewritten lines), so every claim stays marked.
    const sourceAnalysis = analyzeSourceOnly(before, after, globals, result);
    self.postMessage({ id, result: { ...presentDiff(result), sourceAnalysis } });
  } catch {
    self.postMessage({ id });
  }
};
