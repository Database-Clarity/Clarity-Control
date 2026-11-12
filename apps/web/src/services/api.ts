import {
  hashSchema,
  langSchema,
  syncedSettingsSchema,
  tooltipSchema,
  type SyncedSettings,
  type Tooltip,
} from '@clarity/core';
import { z } from 'zod';

export const apiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '') || undefined;
const userSchema = z.object({
  id: z.union([z.number(), z.string()]),
  login: z.string(),
  // `partner` (export partners, spec section 4) has no editing role: until the partner pages
  // exist it reads as no role, so every editing control stays off for it.
  role: z
    .enum(['maintainer', 'editor', 'trial', 'translator', 'partner'])
    .nullable()
    .transform((role) => (role === 'partner' ? null : role)),
  languages: z.array(langSchema).optional(),
  /** Export projects this account is a partner of. */
  projects: z.array(z.string()).optional(),
});
export type User = z.infer<typeof userSchema>;
export type Me = User;
export interface Change {
  hash: number;
  base: Tooltip | null;
  next: Tooltip;
}
const conflictSchema = z.object({
  hash: hashSchema,
  base: tooltipSchema.nullable(),
  head: tooltipSchema.nullable(),
  next: tooltipSchema,
  fields: z.array(z.string()),
});
export type SaveConflict = z.infer<typeof conflictSchema>;
export type SaveResult =
  | { kind: 'saved'; commit: string; tooltips: Tooltip[] }
  | { kind: 'conflicts'; conflicts: z.infer<typeof conflictSchema>[] }
  | { kind: 'retry'; error: string };

export {
  setSession,
  clearSession,
  subscribeSession,
  rememberSignIn,
  consumePendingSignIn,
} from './session';
import { sessionToken, dropRejectedSession } from './session';
function authorization(): Record<string, string> {
  const token = sessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function endpoint(path: string): string {
  if (!apiUrl) throw new Error('VITE_API_URL is not configured. This app is read-only.');
  return `${apiUrl}${path}`;
}

export function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authorization())) headers.set(name, value);
  return fetch(endpoint(path), { ...init, credentials: 'omit', headers });
}

async function failure(response: Response): Promise<never> {
  throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
}

const legacyOrigin = 'https://database-clarity.github.io';

/**
 * The sign-in URL carries the prepared browser nonce. The legacy site and local development
 * use the primary return target; other sites name their origin so sign-in returns to them.
 */
export function loginUrl(client?: string): string {
  const url = endpoint('/auth/login') + (client ? `?client=${encodeURIComponent(client)}` : '');
  if (typeof location === 'undefined') return url;
  const { origin, hostname } = location;
  if (origin === legacyOrigin || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname)) return url;
  return origin.startsWith('http')
    ? `${url}${client ? '&' : '?'}site=${encodeURIComponent(origin)}`
    : url;
}

export async function getMe(): Promise<User | null> {
  const headers = authorization();
  const response = await fetch(endpoint('/me'), {
    credentials: 'omit',
    headers,
  });
  if (response.status === 401) {
    const token = sessionToken();
    if (token && headers.Authorization === `Bearer ${token}`) dropRejectedSession(token);
    return null;
  }
  if (!response.ok) return failure(response);
  return userSchema.parse(await response.json());
}

export async function save(changes: Change[], message: string): Promise<SaveResult> {
  const response = await fetch(endpoint('/save'), {
    method: 'POST',
    credentials: 'omit',
    headers: { ...authorization(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes, message }),
  });
  if (response.status === 409) {
    const data = z
      .union([z.object({ conflicts: z.array(conflictSchema) }), z.object({ error: z.string() })])
      .parse(await response.json());
    return 'conflicts' in data ? { kind: 'conflicts', ...data } : { kind: 'retry', ...data };
  }
  if (!response.ok) return failure(response);
  const data = z
    .object({
      commit: z.string(),
      tooltips: z.array(tooltipSchema),
    })
    .parse(await response.json());
  return { kind: 'saved', ...data };
}

const remoteSettingsSchema = z.object({
  settings: syncedSettingsSchema.nullable(),
  revision: z.string().nullable(),
});
export type RemoteSettings = z.infer<typeof remoteSettingsSchema>;
export type SettingsPutResult =
  | { kind: 'synced'; remote: RemoteSettings }
  | { kind: 'conflict'; remote: RemoteSettings }
  /** `error` is for people; `detail` keeps the technical cause (shown as a tooltip). */
  | { kind: 'failed'; error: string; detail: string };

/** Plain-language reason for a failed settings sync. */
export function syncFailureText(status: number | null): string {
  if (status === null) return 'the connection failed (you may be offline)';
  if (status === 401) return 'sign in again to sync';
  if (status === 403) return 'this account cannot sync settings';
  if (status === 409) return 'the server was busy';
  if (status === 400 || status === 413) return 'the server did not accept these settings';
  return 'the server is unavailable';
}

/** Synced settings for the signed-in user; `settings` is null before the first sync. */
export async function getSettings(): Promise<RemoteSettings> {
  const response = await apiRequest('/settings');
  if (!response.ok) return failure(response);
  return remoteSettingsSchema.parse(await response.json());
}

/** Never throws: sync failures keep the local copy and surface as `failed`. */
export async function putSettings(
  settings: SyncedSettings,
  revision: string | null,
  keepalive = false,
): Promise<SettingsPutResult> {
  try {
    const response = await apiRequest('/settings', {
      method: 'PUT',
      keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, revision }),
    });
    const value: unknown = await response.json().catch(() => null);
    const remote = remoteSettingsSchema.safeParse(value);
    if (response.ok && remote.success) return { kind: 'synced', remote: remote.data };
    if (response.status === 409 && remote.success) return { kind: 'conflict', remote: remote.data };
    const error = z.object({ error: z.string() }).safeParse(value);
    return {
      kind: 'failed',
      error: syncFailureText(response.status),
      detail: `HTTP ${response.status}${error.success ? `: ${error.data.error}` : ''}`,
    };
  } catch (error) {
    return {
      kind: 'failed',
      error: syncFailureText(null),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
