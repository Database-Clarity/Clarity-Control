import type { MarkupGlobals } from '@clarity/core';
import { presentDiff, renderedDiff } from './renderedDiff';
import { sourceAnalysisSteps, type SourceAnalysis } from './sourceOnlyChanges';

/** A comparison request, or a request to drop one (a newer diff or a closed view). */
export type RenderedDiffRequest =
  { id: number; before: string; after: string; globals: MarkupGlobals } | { cancel: number };
/**
 * Replies per request: `result` (the presented diff, or no `result` and no
 * `sourceAnalysis` when the comparison failed), then `sourceAnalysis` once every
 * source part is checked, or `sourceFailed` when the check threw.
 */
export type RenderedDiffReply = {
  id: number;
  result?: ReturnType<typeof renderedDiff>;
  sourceAnalysis?: SourceAnalysis;
  sourceFailed?: true;
};
type Job = Extract<RenderedDiffRequest, { id: number }>;

// The source check has no part cap or time budget; it runs in slices so a
// cancel message can land between them.
const SLICE_MS = 8;
const queue: Job[] = [];
let current: number | undefined;
let cancelled = false;
let running = false;
const reply = (message: RenderedDiffReply) => self.postMessage(message);
// A message task (unlike a nested setTimeout) is not clamped to 4 ms.
const channel = new MessageChannel();
const breathe = () =>
  new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });

async function run({ id, before, after, globals }: Job) {
  let steps: ReturnType<typeof sourceAnalysisSteps>;
  try {
    const result = renderedDiff(before, after, globals);
    // Accounting reads the word diff the user sees; presentDiff then only adds
    // marks (merged runs, whole rewritten lines) in place, so the check reads
    // its own copy and the presented diff can paint first.
    steps = sourceAnalysisSteps(before, after, globals, structuredClone(result));
    reply({ id, result: presentDiff(result) });
  } catch {
    reply({ id });
    return;
  }
  try {
    let slice = performance.now();
    for (;;) {
      const step = steps.next();
      if (step.done) {
        reply({ id, sourceAnalysis: step.value });
        return;
      }
      if (performance.now() - slice < SLICE_MS) continue;
      await breathe();
      if (cancelled) return;
      slice = performance.now();
    }
  } catch {
    reply({ id, sourceFailed: true });
  }
}

async function drain() {
  running = true;
  for (let job = queue.shift(); job; job = queue.shift()) {
    current = job.id;
    cancelled = false;
    await run(job);
  }
  current = undefined;
  running = false;
}

self.onmessage = (event: MessageEvent<RenderedDiffRequest>) => {
  const request = event.data;
  if ('cancel' in request) {
    const index = queue.findIndex((job) => job.id === request.cancel);
    if (index >= 0) queue.splice(index, 1);
    else if (current === request.cancel) cancelled = true;
    return;
  }
  queue.push(request);
  if (!running) void drain();
};
