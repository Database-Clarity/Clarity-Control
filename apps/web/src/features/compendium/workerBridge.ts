import type { CompendiumData } from '@clarity/core';
import { receiveWorkerResult, type WorkerReply } from './workerReplies';

type Receiver = ReturnType<typeof receiveWorkerResult>;
type Job = {
  owner?: object;
  resolve(value: unknown): void;
  reject(error: Error): void;
  receive: Receiver;
  progress?(value: unknown): void;
};

export function createWorkerBridge(worker: Worker) {
  let serial = 0;
  let failure: Error | undefined;
  const jobs = new Map<number, Job>();
  const arrivals: { id: number; reply: WorkerReply }[] = [];
  let active: { id: number; job: Job; steps: ReturnType<Receiver['steps']> } | undefined;
  let scheduled = false;
  const inputPending = () =>
    (
      globalThis.navigator as Navigator & {
        scheduling?: { isInputPending(options?: { includeContinuous: boolean }): boolean };
      }
    )?.scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  const schedule = () => {
    if (scheduled || failure) return;
    scheduled = true;
    const scheduler = (
      globalThis as typeof globalThis & {
        scheduler?: {
          postTask(callback: () => void, options: { priority: 'background' }): Promise<unknown>;
        };
      }
    ).scheduler;
    // Background-priority continuations can use otherwise free time between
    // frames. Nested idle callbacks alone limited decoding to one slice/frame
    // even when no input or rendering work was pending.
    if (scheduler && !inputPending())
      void scheduler
        .postTask(() => decode(), { priority: 'background' })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          rejectAll(failure);
        });
    else if (typeof requestIdleCallback === 'function') requestIdleCallback(decode);
    else setTimeout(decode, 0);
  };
  function decode(deadline?: IdleDeadline) {
    scheduled = false;
    if (failure) return;
    const start = performance.now();
    const end = start + Math.min(2, deadline?.timeRemaining() ?? 2);
    while (performance.now() < end && !inputPending()) {
      if (active && jobs.get(active.id) !== active.job) active = undefined;
      if (!active) {
        const next = arrivals.shift();
        if (!next) break;
        const job = jobs.get(next.id);
        if (!job) continue;
        active = { id: next.id, job, steps: job.receive.steps(next.reply) };
      }
      const { id, job } = active;
      try {
        const next = active.steps.next();
        if (!next.done) continue;
        active = undefined;
        const result = next.value;
        performance.mark('compendium:result-ready', { detail: { id, partial: !result.done } });
        performance.clearMarks('compendium:result-ready');
        if (result.done) {
          jobs.delete(id);
          job.resolve(result.value);
        } else if ('partial' in result) job.progress?.(result.partial);
      } catch (error) {
        active = undefined;
        jobs.delete(id);
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    performance.measure('compendium:decode', { start, end: performance.now() });
    performance.clearMeasures('compendium:decode');
    if (active || arrivals.length) schedule();
  }
  const rejectAll = (error: Error) => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
    arrivals.length = 0;
    active = undefined;
  };
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    const job = jobs.get(data.id);
    if (!job) return;
    if (data.error) {
      jobs.delete(data.id);
      job.reject(new Error(data.error));
      return;
    }
    arrivals.push({ id: data.id, reply: data });
    schedule();
  };
  worker.onerror = () => {
    failure = new Error('Compendium worker failed. Reload published data to retry.');
    rejectAll(failure);
  };
  const post = (payload: object, transfer: Transferable[] = []) => {
    if (failure) throw failure;
    worker.postMessage(payload, transfer);
  };
  return {
    post,
    get disposed() {
      return !!failure;
    },
    request<T>(payload: object, owner?: object, progress?: (value: unknown) => void): Promise<T> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++serial;
        jobs.set(id, {
          owner,
          progress,
          resolve: (value) => resolve(value as T),
          reject,
          receive: receiveWorkerResult(),
        });
        try {
          post({ ...payload, id });
        } catch (error) {
          jobs.delete(id);
          reject(error);
        }
      });
    },
    cancel(owner: object) {
      for (const [id, job] of jobs)
        if (job.owner === owner) {
          jobs.delete(id);
          job.reject(new Error('Compendium inputs changed.'));
        }
    },
    dispose() {
      failure ??= new Error('Compendium inputs changed.');
      worker.terminate();
      rejectAll(failure);
    },
  };
}
export type WorkerBridge = ReturnType<typeof createWorkerBridge>;
const sources = new WeakMap<CompendiumData, WorkerBridge>();
export function bindSourceWorker(source: CompendiumData, bridge: WorkerBridge) {
  sources.set(source, bridge);
}
export function sourceWorkerFor(source: CompendiumData) {
  const bridge = sources.get(source);
  return bridge && !bridge.disposed ? bridge : undefined;
}
export function retireSourceWorker(source: CompendiumData) {
  sources.get(source)?.dispose();
  sources.delete(source);
}
