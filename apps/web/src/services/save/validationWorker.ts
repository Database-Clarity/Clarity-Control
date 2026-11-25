import type { TooltipValidationIssue } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import type { LiveFallback } from './fallback';

type Reply = { id: number; issues?: TooltipValidationIssue[]; chunks?: Change[][]; error?: string };
type Request = {
  changes: Change[];
  fallback?: LiveFallback;
  clearing?: boolean;
  plan?: { message: string; noTranslationImpact: boolean };
};

let worker: Worker | undefined;
let sequence = 0;
let revision = 0;
let postedData: EditorData | undefined;
const results = new WeakMap<EditorData, Map<string, Promise<TooltipValidationIssue[]>>>();
const jobs = new Map<
  number,
  {
    resolve(reply: Reply): void;
    reject(error: Error): void;
  }
>();

function getWorker(): Worker {
  if (worker) return worker;
  // Fail closed if workers cannot start; never do catalogue validation on the UI thread.
  worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const job = jobs.get(event.data.id);
    if (!job) return;
    jobs.delete(event.data.id);
    if (event.data.issues || event.data.chunks) job.resolve(event.data);
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

function request(data: EditorData, input: Request): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    try {
      const target = getWorker();
      const changed = postedData !== data;
      if (changed) revision++;
      jobs.set(id, { resolve, reject });
      target.postMessage({ id, revision, ...input, ...(changed ? { data } : {}) });
      postedData = data;
    } catch (error) {
      jobs.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function requestSaveChunks(
  changes: Change[],
  data: EditorData,
  message: string,
  noTranslationImpact: boolean,
): Promise<Change[][]> {
  const { chunks } = await request(data, { changes, plan: { message, noTranslationImpact } });
  if (!chunks) throw new Error('Save plan missing.');
  return chunks;
}

/** Immutable EditorData identity covers all saved inputs, including conflict overlays.
 * Exact serialized changes include recovered bases and metadata, not just changed hashes.
 * The predicted English fallback (fallback.ts) joins the key only when it lists something, so
 * the review and prepareChanges share one promise unless the fallback differs between them.
 * The same promise is reused by review and prepareChanges, including pending requests.
 */
export function requestSaveValidation(
  changes: Change[],
  data: EditorData,
  fallback: LiveFallback = {},
  clearing = false,
): Promise<TooltipValidationIssue[]> {
  let cache = results.get(data);
  if (!cache) results.set(data, (cache = new Map()));
  const live = Object.keys(fallback).length ? fallback : undefined;
  const key = `${JSON.stringify(changes)}${live ? `\n${JSON.stringify(live)}` : ''}${clearing ? '\nclearing' : ''}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = request(data, {
    changes,
    ...(live ? { fallback: live } : {}),
    ...(clearing ? { clearing } : {}),
  }).then(({ issues }) => {
    if (!issues) throw new Error('Save validation result missing.');
    return issues;
  });
  cache.set(key, promise);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  // Failed jobs can be retried on reopening the review.
  void promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}
