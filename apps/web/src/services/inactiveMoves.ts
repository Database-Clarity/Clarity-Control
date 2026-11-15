import { inactiveMovesSchema } from '@clarity/core';
import { z } from 'zod';
import { apiRequest } from './api';

const loadedSchema = z.object({
  revision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  moves: inactiveMovesSchema,
});
export type LoadedInactiveMoves = z.infer<typeof loadedSchema>;

async function checked(response: Response): Promise<LoadedInactiveMoves> {
  if (response.ok) return loadedSchema.parse(await response.json());
  let detail = `HTTP ${response.status}`;
  try {
    const value = (await response.json()) as { error?: string };
    detail = value.error ?? detail;
  } catch {
    /* Keep the status when an upstream response is not JSON. */
  }
  throw new Error(detail);
}

export async function getInactiveMoves(signal?: AbortSignal) {
  return checked(await apiRequest('/inactive-moves', { signal }));
}

export async function putInactiveMove(hash: number, inactive: boolean, revision: string | null) {
  return checked(
    await apiRequest('/inactive-moves', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, inactive, revision }),
    }),
  );
}
