import { inactiveMovesSchema } from '@clarity/core';
import { fetchJson, fetchOptionalJson } from './http';
import { bundleSchema, type Bundle } from './bundleSchema';
export { bundleSchema, type Bundle } from './bundleSchema';

export const bundleUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json';

export const inactiveMovesUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data/config/inactive.json';

export async function loadBundle(signal?: AbortSignal): Promise<Bundle> {
  // Moves are small, authoritative editor data. Do not wait for the asynchronously rebuilt
  // bundle to hide a moved item from another role's queue, or to restore it on reload.
  const [bundle, moves] = await Promise.all([
    fetchJson(bundleUrl, bundleSchema, { signal, cache: 'no-cache' }),
    fetchOptionalJson(`${inactiveMovesUrl}?at=${Date.now()}`, inactiveMovesSchema, {
      signal,
      cache: 'no-store',
    }),
  ]);
  return { ...bundle, inactiveMoves: moves ?? {} };
}
