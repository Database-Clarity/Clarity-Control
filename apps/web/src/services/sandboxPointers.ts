import { sandboxPointersSchema, type SandboxPick, type SandboxPointers } from '@clarity/core';
import { z } from 'zod';
import { apiRequest } from './api';

/** The maintainer picks with the revision they were read at; a save sends the revision back. */
export interface LoadedSandboxPointers {
  revision: string | null;
  pointers: SandboxPointers;
  /** Whether the active exporter applies picks (false: the installed publisher predates them). */
  exporting: boolean;
}

const loadedSchema = z.object({
  revision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  pointers: sandboxPointersSchema,
  exporting: z.boolean(),
});

export const sandboxPointersChangedMessage =
  'Sandbox picks changed since you loaded them (another maintainer saved first). Reload to see the current picks, then re-apply your changes.';

async function checked(response: Response): Promise<unknown> {
  if (response.ok) return response.json();
  const text = await response.text();
  let detail = text;
  try {
    const body = JSON.parse(text) as { error?: string; details?: unknown };
    detail = [body.error, ...(Array.isArray(body.details) ? body.details : [])]
      .filter(Boolean)
      .join('; ');
  } catch {
    /* plain text */
  }
  throw new Error(`Sandbox picks HTTP ${response.status}: ${detail}`);
}

export async function getSandboxPointers(signal?: AbortSignal): Promise<LoadedSandboxPointers> {
  return loadedSchema.parse(await checked(await apiRequest('/sandbox-pointers', { signal })));
}

/** Saves the complete set of picks (an omitted hash is undone). */
export async function putSandboxPointers(
  picks: Record<string, SandboxPick>,
  revision: string | null,
): Promise<LoadedSandboxPointers> {
  const response = await apiRequest('/sandbox-pointers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, picks }),
  });
  if (response.status === 409) {
    const text = await response.text();
    // A stale revision has its own message; the publisher gate explains itself.
    if (/changed since they were loaded/.test(text)) throw new Error(sandboxPointersChangedMessage);
    throw new Error(`Sandbox picks HTTP 409: ${JSON.parse(text).error ?? text}`);
  }
  return loadedSchema.parse(await checked(response));
}
