import type { TooltipValidationIssue } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';

let worker: Worker | undefined;
let sequence = 0;
let revision = 0;
let postedData: EditorData | undefined;
const results = new WeakMap<EditorData, Map<string, Promise<TooltipValidationIssue[]>>>();
const jobs = new Map<
  number,
  {
    resolve(issues: TooltipValidationIssue[]): void;
    reject(error: Error): void;
  }
>();

function getWorker(): Worker {
  if (worker) return worker;
  // Fail closed if workers cannot start; never do catalogue validation on the UI thread.
  worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (
    event: MessageEvent<{
      id: number;
      issues?: TooltipValidationIssue[];
      error?: string;
    }>,
  ) => {
    const job = jobs.get(event.data.id);
    if (!job) return;
    jobs.delete(event.data.id);
    if (event.data.issues) job.resolve(event.data.issues);
    else job.reject(new Error(event.data.error ?? 'Save validation failed.'));
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = undefined;
    postedData = undefined;
    for (const job of jobs.values())
      job.reject(new Error('Save validation worker unavailable. Reopen the save review to retry.'));
    jobs.clear();
  };
  return worker;
}

/** Immutable EditorData identity covers all saved inputs, including conflict overlays.
 * Exact serialized changes include recovered bases and metadata, not just changed hashes.
 * The same promise is reused by review and prepareChanges, including pending requests.
 */
export function requestSaveValidation(
  changes: Change[],
  data: EditorData,
): Promise<TooltipValidationIssue[]> {
  let cache = results.get(data);
  if (!cache) results.set(data, (cache = new Map()));
  const key = JSON.stringify(changes);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = new Promise<TooltipValidationIssue[]>((resolve, reject) => {
    const id = ++sequence;
    try {
      const target = getWorker();
      const changed = postedData !== data;
      if (changed) revision++;
      jobs.set(id, { resolve, reject });
      target.postMessage({ id, revision, changes, ...(changed ? { data } : {}) });
      postedData = data;
    } catch (error) {
      jobs.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  cache.set(key, promise);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  // Failed jobs can be retried on reopening the review.
  void promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}
