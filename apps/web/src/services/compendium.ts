import { compendiumDataSchema, isTrackedCompendiumTab, type CompendiumData } from '@clarity/core';
import { z } from 'zod';
import { fetchJson } from './http';
import { apiRequest } from './api';
import { receiveWorkerResult, type WorkerReply } from '../features/compendium/workerReplies';

export const compendiumDataUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json';
let cached: { value: CompendiumData; at: number } | undefined;
let pending: Promise<CompendiumData> | undefined;
let started = 0;
let applied = 0;
function fetchSource() {
  if (typeof Worker === 'undefined')
    return fetchJson(compendiumDataUrl, compendiumDataSchema, { cache: 'no-cache' });
  return new Promise<CompendiumData>((resolve, reject) => {
    const worker = new Worker(new URL('./compendium.worker.ts', import.meta.url), {
      type: 'module',
    });
    const receive = receiveWorkerResult();
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.error) {
        worker.terminate();
        reject(new Error(data.error));
        return;
      }
      try {
        const result = receive(data);
        if (result.done) {
          worker.terminate();
          resolve(result.value as CompendiumData);
        }
      } catch (error) {
        worker.terminate();
        reject(error);
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Compendium download failed. Reload published data to retry.'));
    };
    worker.postMessage({ url: compendiumDataUrl });
  });
}
export function loadCompendium(force = false): Promise<CompendiumData> {
  if (!force && cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.value);
  // Only a non-forced call may join a request in flight: a forced reload must be a fetch
  // that starts now, or it could return data from before the refresh it follows.
  if (!force && pending) return pending;
  const id = ++started;
  const request: Promise<CompendiumData> = fetchSource()
    .then((value) => {
      const tracked = {
        ...value,
        tabs: value.tabs.filter((tab) => isTrackedCompendiumTab(tab.name)),
      };
      // A slower, older request must not overwrite newer data.
      if (id > applied) {
        applied = id;
        cached = { value: tracked, at: Date.now() };
      }
      return tracked;
    })
    .finally(() => {
      if (pending === request) pending = undefined;
    });
  pending = request;
  return request;
}

const refreshRequestSchema = z.object({
  requestedAt: z.string().datetime({ offset: true }),
  runId: z.number().nullable(),
});
const refreshStatusSchema = z.object({
  run: z
    .object({
      id: z.number(),
      status: z.string(),
      conclusion: z.string().nullable(),
      created_at: z.string().datetime({ offset: true }),
      html_url: z.string().url(),
    })
    .nullable(),
});
export async function requestCompendiumRefresh() {
  const response = await apiRequest('/compendium/refresh', { method: 'POST' });
  if (!response.ok)
    throw new Error(`Compendium refresh HTTP ${response.status}: ${await response.text()}`);
  return refreshRequestSchema.parse(await response.json());
}
export async function compendiumRefreshStatus() {
  const response = await apiRequest('/compendium/refresh/status');
  if (!response.ok)
    throw new Error(`Compendium status HTTP ${response.status}: ${await response.text()}`);
  return refreshStatusSchema.parse(await response.json()).run;
}
export function isRequestedRun(
  request: z.infer<typeof refreshRequestSchema>,
  run: NonNullable<Awaited<ReturnType<typeof compendiumRefreshStatus>>>,
) {
  return request.runId !== null
    ? run.id === request.runId
    : Date.parse(run.created_at) >= Date.parse(request.requestedAt) - 2000;
}
