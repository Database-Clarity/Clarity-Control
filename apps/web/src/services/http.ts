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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
