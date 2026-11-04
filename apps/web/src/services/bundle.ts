import { fetchJson } from './http';
import { bundleSchema, type Bundle } from './bundleSchema';
export { bundleSchema, type Bundle } from './bundleSchema';

export const bundleUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json';

export function loadBundle(signal?: AbortSignal): Promise<Bundle> {
  return fetchJson(bundleUrl, bundleSchema, { signal, cache: 'no-cache' });
}
