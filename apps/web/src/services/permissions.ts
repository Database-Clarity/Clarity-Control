import { permissionsSchema } from '@clarity/core';
import type { Permissions } from '@clarity/core';
import { z } from 'zod';
import { apiRequest } from './api';
import { fetchJson } from './http';

async function checked(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new Error(`Permissions HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

/** Permissions plus the revision they were read at; a save must send the revision back. */
export type LoadedPermissions = { revision: string; permissions: Permissions };

const loadedSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  permissions: permissionsSchema,
});

export const permissionsChangedMessage =
  'Permissions changed since you loaded them (another admin saved first). Reload to see the current permissions, then re-apply your edit.';

export async function getPermissions(signal?: AbortSignal): Promise<LoadedPermissions> {
  return loadedSchema.parse(await checked(await apiRequest('/permissions', { signal })));
}

export async function putPermissions(
  permissions: Permissions,
  revision: string,
): Promise<LoadedPermissions> {
  const input = permissionsSchema.parse(permissions);
  if (!Object.values(input.users).some((entry) => entry.role === 'maintainer')) {
    throw new Error('At least one maintainer must remain.');
  }
  const response = await apiRequest('/permissions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, permissions: input }),
  });
  if (response.status === 409) throw new Error(permissionsChangedMessage);
  return loadedSchema.parse(await checked(response));
}

export async function resolveGitHubLogin(login: string) {
  const value = login.trim();
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) {
    throw new Error('Enter a GitHub login, not a profile URL or email address.');
  }
  return fetchJson(
    `https://api.github.com/users/${encodeURIComponent(value)}`,
    z.object({
      id: z.number().int().positive(),
      login: z.string().min(1),
    }),
    { credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } },
  );
}
