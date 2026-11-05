import { sameCell, type CompendiumCell } from '@clarity/core';
import { projectCompendiumDiff, type PreparedDiffLines } from './compendiumDiffProjection';

const cache = new Map<string, PreparedDiffLines>();
const keyFor = (before: CompendiumCell, after: CompendiumCell) => JSON.stringify([before, after]);
function remember(key: string, lines: PreparedDiffLines) {
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, lines);
}

type Job = {
  id: number;
  key: string;
  before: CompendiumCell;
  after: CompendiumCell;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
let serial = 0;
let worker: Worker | undefined;
let active: Job | undefined;
const pending = new Map<string, Job>();
const queue: Job[] = [];

function finish(job: Job, lines: PreparedDiffLines) {
  if (active !== job) return;
  remember(job.key, lines);
  pending.delete(job.key);
  active = undefined;
  job.resolve();
  dispatch();
}
function fallback(job: Job) {
  // Unsupported/blocked workers retain the same output, outside the paint rAF.
  setTimeout(() => {
    if (active !== job) return;
    try {
      finish(job, projectCompendiumDiff(job.before, job.after));
    } catch (error) {
      pending.delete(job.key);
      active = undefined;
      job.reject(error);
      dispatch();
    }
  }, 0);
}
/** Start the small renderer worker when the pane opens, for every target equally. */
export function initializeCompendiumDiffWorker() {
  if (worker || typeof Worker === 'undefined') return;
  try {
    worker = new Worker(new URL('./compendiumDiff.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; lines: PreparedDiffLines }>) => {
      if (active?.id === event.data.id) finish(active, event.data.lines);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = undefined;
      if (active) fallback(active);
    };
  } catch {
    worker = undefined;
  }
}
function dispatch() {
  if (active || !queue.length) return;
  active = queue.shift()!;
  initializeCompendiumDiffWorker();
  if (worker) worker.postMessage({ id: active.id, before: active.before, after: active.after });
  else fallback(active);
}

/** Prepare immutable content before the pane's render/paint callback. */
export function prepareCompendiumDiff(
  before: CompendiumCell,
  after: CompendiumCell,
  signal: AbortSignal,
): Promise<void> | undefined {
  const key = keyFor(before, after);
  if (cache.has(key)) return;
  if (sameCell(before, after)) {
    remember(key, projectCompendiumDiff(before, after));
    return;
  }
  const existing = pending.get(key);
  if (existing) return existing.promise;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const job: Job = { id: ++serial, key, before, after, promise, resolve, reject };
  pending.set(key, job);
  queue.push(job);
  signal.addEventListener(
    'abort',
    () => {
      // A running calculation may populate the content cache, but superseded
      // queued targets never delay the newest target behind a worker backlog.
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
      pending.delete(key);
      reject(new DOMException('Pane target superseded', 'AbortError'));
    },
    { once: true },
  );
  dispatch();
  return promise;
}

/** Other diff surfaces retain synchronous rendering, with the same bounded cache. */
export function preparedLines(before: CompendiumCell, after: CompendiumCell) {
  const key = keyFor(before, after);
  const existing = cache.get(key);
  if (existing) return existing;
  const lines = projectCompendiumDiff(before, after);
  remember(key, lines);
  return lines;
}
