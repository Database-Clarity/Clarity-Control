import { z } from 'zod';

export async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return schema.parse(await response.json());
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
  return schema.parse(await response.json());
}

/** Browsers reject `fetch` with a bare TypeError ("Failed to fetch", "Load failed", ...). */
const networkFailure = /failed to fetch|networkerror|load failed|network request failed/i;

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError && networkFailure.test(error.message))
    return 'Could not reach the server (the connection failed or you may be offline). Check your connection.';
  return error instanceof Error ? error.message : String(error);
}
