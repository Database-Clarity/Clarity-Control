import { z } from 'zod';
import { validateInWorker } from './jsonValidationClient';

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (typeof Worker !== 'undefined') {
    // Match schema identity, never just a URL: callers cannot accidentally bypass validation.
    const [{ bundleSchema }, { itemsSchema }] = await Promise.all([
      import('./bundleSchema'),
      import('./generatorSchema'),
    ]);
    const kind =
      (schema as z.ZodType) === bundleSchema
        ? 'bundle'
        : (schema as z.ZodType) === itemsSchema
          ? 'items'
          : undefined;
    if (kind) {
      const bytes = await validateInWorker(kind, await response.arrayBuffer());
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }
  }
  return schema.parse(await response.json());
}

export async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseResponse(response, schema);
}

/** Like `fetchJson`, but a 404 yields `undefined` (the file is optional). */
export async function fetchOptionalJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T | undefined> {
  const response = await fetch(url, init);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseResponse(response, schema);
}

/** Browsers reject `fetch` with a bare TypeError ("Failed to fetch", "Load failed", ...). */
const networkFailure = /failed to fetch|networkerror|load failed|network request failed/i;

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError && networkFailure.test(error.message))
    return 'Could not reach the server (the connection failed or you may be offline). Check your connection.';
  return error instanceof Error ? error.message : String(error);
}
