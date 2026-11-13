import { hashSchema } from '../../../../packages/core/src/legacy';
import { syncedSettingsSchema, type SyncedSettings } from '../../../../packages/core/src/settings';
import { tooltipSchema, type Tooltip } from '../../../../packages/core/src/schemas';
import { z } from 'zod';

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
  | { kind: 'saved'; commit: string; tooltips: Tooltip[]; savedAt?: number }
  | { kind: 'conflicts'; conflicts: z.infer<typeof conflictSchema>[]; serverAt?: number }
  | { kind: 'retry'; error: string };

// Sign-in, sessions, `/me`, and authorized requests live in a zod/mini module the public report
// page loads instead of this one, without the editor's save and settings schemas.
import { apiRequest, authorization, endpoint, failure } from './apiAuth';
export {
  apiUrl,
  apiRequest,
  loginUrl,
  getMe,
  setSession,
  clearSession,
  subscribeSession,
  rememberSignIn,
  consumePendingSignIn,
  type User,
  type Me,
} from './apiAuth';

/**
 * The server's clock when it answered (the Worker exposes `Date` to the editor's origins), so
 * saved-overlay retirement does not depend on the browser clock. Undefined when the header is
 * missing, unreadable, or out of range: callers then fall back to the browser clock.
 */
export function serverTime(response: Response): number | undefined {
  const time = Date.parse(response.headers.get('Date') ?? '');
  return Number.isFinite(time) && time > 0 ? time : undefined;
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
    const serverAt = serverTime(response);
    return 'conflicts' in data
      ? { kind: 'conflicts', ...data, ...(serverAt === undefined ? {} : { serverAt }) }
      : { kind: 'retry', ...data };
  }
  if (!response.ok) return failure(response);
  const data = z
    .object({
      commit: z.string(),
      tooltips: z.array(tooltipSchema),
      // Older Workers omit this field; malformed times use the same browser-clock fallback.
      savedAt: z.number().int().positive().max(8.64e15).optional().catch(undefined),
    })
    .parse(await response.json());
  // The explicit post-commit time is the more precise one; Date covers bodies without it.
  const savedAt = data.savedAt ?? serverTime(response);
  return { kind: 'saved', ...data, ...(savedAt === undefined ? {} : { savedAt }) };
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
