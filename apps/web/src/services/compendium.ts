import { compendiumDataSchema, isTrackedCompendiumTab, type CompendiumData } from '@clarity/core';
import { z } from 'zod';
import { fetchJson } from './http';
import { apiRequest } from './api';

export const compendiumDataUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json';
let cached: { value: CompendiumData; at: number } | undefined;
let pending: Promise<CompendiumData> | undefined;
export function loadCompendium(force = false): Promise<CompendiumData> {
  if (!force && cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.value);
  pending ??= fetchJson(compendiumDataUrl, compendiumDataSchema, { cache: 'no-cache' })
    .then((value) => {
      const tracked = {
        ...value,
        tabs: value.tabs.filter((tab) => isTrackedCompendiumTab(tab.name)),
      };
      cached = { value: tracked, at: Date.now() };
      return tracked;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
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
