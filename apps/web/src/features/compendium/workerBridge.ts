import type { CompendiumData } from '@clarity/core';
import { receiveWorkerResult, type WorkerReply } from './workerReplies';

export function createWorkerBridge(worker: Worker) {
  let serial = 0;
  let failure: Error | undefined;
  const jobs = new Map<
    number,
    {
      owner?: object;
      resolve(value: unknown): void;
      reject(error: Error): void;
      receive: ReturnType<typeof receiveWorkerResult>;
    }
  >();
  const rejectAll = (error: Error) => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    const job = jobs.get(data.id);
    if (!job) return;
    try {
      if (data.error) throw new Error(data.error);
      const result = job.receive(data);
      if (result.done) {
        jobs.delete(data.id);
        job.resolve(result.value);
      }
    } catch (error) {
      jobs.delete(data.id);
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }
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
    request<T>(payload: object, owner?: object): Promise<T> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++serial;
        jobs.set(id, {
          owner,
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
