import type { CompendiumData } from '@clarity/core';
import { receiveWorkerResult, type WorkerReply } from './workerReplies';
import {
  backgroundDecodePaused,
  onBackgroundDecodeResume,
  watchEditorInput,
} from './paneDecodeActivity';

type Receiver = ReturnType<typeof receiveWorkerResult>;
type Job = {
  urgent: boolean;
  owner?: object;
  resolve(value: unknown): void;
  reject(error: Error): void;
  receive: Receiver;
  progress?(value: unknown): void;
};

export function createWorkerBridge(worker: Worker) {
  watchEditorInput();
  let serial = 0;
  let failure: Error | undefined;
  const jobs = new Map<number, Job>();
  const arrivals: { id: number; reply?: WorkerReply; steps?: ReturnType<Receiver['steps']> }[] = [];
  let active: { id: number; job: Job; steps: ReturnType<Receiver['steps']> } | undefined;
  let scheduled = false;
  let scheduledUrgent = false;
  let scheduleGeneration = 0;
  const inputPending = () =>
    (
      globalThis.navigator as Navigator & {
        scheduling?: { isInputPending(options?: { includeContinuous: boolean }): boolean };
      }
    )?.scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  const schedule = (urgent = false) => {
    if (
      failure ||
      (backgroundDecodePaused() && !urgent) ||
      (scheduled && (!urgent || scheduledUrgent))
    )
      return;
    scheduled = true;
    scheduledUrgent = urgent;
    const generation = ++scheduleGeneration;
    const run = (deadline?: IdleDeadline) => {
      if (generation === scheduleGeneration) decode(deadline);
    };
    const scheduler = (
      globalThis as typeof globalThis & {
        scheduler?: {
          postTask(
            callback: () => void,
            options: { priority: 'background' | 'user-visible' },
          ): Promise<unknown>;
        };
      }
    ).scheduler;
    // Background-priority continuations can use otherwise free time between
    // frames. Nested idle callbacks alone limited decoding to one slice/frame
    // even when no input or rendering work was pending.
    if (scheduler && !inputPending())
      void scheduler
        .postTask(() => run(), { priority: urgent ? 'user-visible' : 'background' })
        .catch((error: unknown) => {
          if (generation !== scheduleGeneration) return;
          failure = error instanceof Error ? error : new Error(String(error));
          rejectAll(failure);
        });
    else if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
    else setTimeout(run, 0);
  };
  function decode(deadline?: IdleDeadline) {
    scheduled = false;
    if (failure) return;
    const start = performance.now();
    const end = start + Math.min(2, deadline?.timeRemaining() ?? 2);
    let steps = 0;
    // Checking native scheduling APIs for every graph node dominated decode CPU.
    // Poll in small batches, including before the first node of each slice.
    while (steps++ % 16 !== 0 || (performance.now() < end && !inputPending())) {
      if (active && jobs.get(active.id) !== active.job) active = undefined;
      if (backgroundDecodePaused() && active && !active.job.urgent) {
        arrivals.unshift({ id: active.id, steps: active.steps });
        active = undefined;
      }
      if (!active) {
        const index = backgroundDecodePaused()
          ? arrivals.findIndex((arrival) => jobs.get(arrival.id)?.urgent)
          : 0;
        if (index < 0) break;
        const next = arrivals.splice(index, 1)[0];
        if (!next) break;
        const job = jobs.get(next.id);
        if (!job) continue;
        active = { id: next.id, job, steps: next.steps ?? job.receive.steps(next.reply!) };
      }
      const { id, job } = active;
      try {
        const next = active.steps.next();
        if (!next.done) continue;
        active = undefined;
        const result = next.value;
        if (import.meta.env.DEV) {
          performance.mark('compendium:result-ready', { detail: { id, partial: !result.done } });
          performance.clearMarks('compendium:result-ready');
        }
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
    if (import.meta.env.DEV) {
      performance.measure('compendium:decode', { start, end: performance.now() });
      performance.clearMeasures('compendium:decode');
    }
    if (active || arrivals.length)
      schedule(!!active?.job.urgent || arrivals.some((arrival) => jobs.get(arrival.id)?.urgent));
  }
  const unsubscribe = onBackgroundDecodeResume(() => {
    if (active || arrivals.length)
      schedule(!!active?.job.urgent || arrivals.some((arrival) => jobs.get(arrival.id)?.urgent));
  });
  const rejectAll = (error: Error) => {
    unsubscribe();
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
    if (job.urgent && active && !active.job.urgent) {
      // Keep this receiver's graph/partial stage intact while the pane decodes.
      arrivals.unshift({ id: active.id, steps: active.steps });
      active = undefined;
    }
    const beforeBackground = job.urgent
      ? arrivals.findIndex((arrival) => !jobs.get(arrival.id)?.urgent)
      : -1;
    arrivals.splice(beforeBackground < 0 ? arrivals.length : beforeBackground, 0, {
      id: data.id,
      reply: data,
    });
    schedule(job.urgent);
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
          urgent: 'priority' in payload,
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
