import { z } from 'zod';
import { settingsBodyLimit, stableStringify, syncedSettingsSchema } from '@clarity/core';
import { base64url, unbase64 } from './crypto.js';
import type { GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

/** Private D1 rows retain opaque HMAC ids and per-entry AES-GCM authentication.
 * Keys are domain-separated HKDF derivatives of SESSION_SECRET, as before.
 */
export const settingsDomain = 'clarity-user-settings-v1';
const encoder = new TextEncoder();

/** Narrow structural D1 contract, matching the Worker's existing binding conventions. */
export interface SettingsStatement {
  bind(...values: (string | number | null)[]): SettingsStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface SettingsDatabase {
  prepare(sql: string): SettingsStatement;
}
interface SettingsRow {
  iv: string;
  ct: string;
  revision: string;
}

const entrySchema = z
  .object({
    iv: z.string().regex(/^[\w-]{16}$/),
    ct: z
      .string()
      .regex(/^[\w-]+$/)
      .max(8192),
  })
  .strict();
export type SettingsEntry = z.infer<typeof entrySchema>;
const plainSchema = z
  .object({ settings: syncedSettingsSchema, revision: z.string().regex(/^[0-9a-f]{32}$/) })
  .strict();
type Plain = z.infer<typeof plainSchema>;
const putSchema = z
  .object({
    settings: syncedSettingsSchema,
    revision: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
  })
  .strict();

async function derive(secret: string, info: string): Promise<ArrayBuffer> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(settingsDomain),
      info: encoder.encode(info),
    },
    base,
    256,
  );
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Opaque, stable entry id: HMAC-SHA256 keyed by an HKDF-derived server key. */
export async function settingsFileId(secret: string, userId: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await derive(secret, `${settingsDomain}/file-id`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(userId))));
}

/** Server-wide content key; each row authenticates its own user id. */
export async function settingsKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    await derive(secret, `${settingsDomain}/aes-256-gcm`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

const associatedData = (id: string) => encoder.encode(`${settingsDomain}:${id}`);

export async function encryptEntry(
  key: CryptoKey,
  id: string,
  plain: Plain,
): Promise<SettingsEntry> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(id) },
    key,
    encoder.encode(JSON.stringify(plain)),
  );
  return { iv: base64url(iv), ct: base64url(new Uint8Array(ct)) };
}

/** `null` when the entry is not a valid, authentic ciphertext for this id. */
export async function decryptEntry(
  key: CryptoKey,
  id: string,
  stored: unknown,
): Promise<Plain | null> {
  const entry = entrySchema.safeParse(stored);
  if (!entry.success) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(entry.data.iv), additionalData: associatedData(id) },
      key,
      unbase64(entry.data.ct),
    );
    const result = plainSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * GET returns `{ settings, revision, unreadable }`; PUT `{ settings, revision }` writes when
 * `revision` matches the caller's stored entry (null = none or unreadable), else 409 with it.
 * Any user with an editing role may sync; others keep settings in the browser.
 */
export async function userSettings(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const input = request.method === 'PUT' ? await body(request, putSchema, settingsBodyLimit) : null;
  const secret = github.env.SESSION_SECRET;
  const id = await settingsFileId(secret, user.id);
  const key = await settingsKey(secret);
  // Authorization still uses fresh permissions; settings storage never calls GitHub.
  requireAccess(await permissions(github, await github.head()), user, [
    'maintainer',
    'editor',
    'trial',
    'translator',
  ]);
  const db = github.env.SETTINGS_DB;
  if (!db) throw new HttpError(503, 'Settings are unavailable');
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare('SELECT iv, ct, revision FROM user_settings WHERE id = ?')
      .bind(id)
      .first<SettingsRow>();
    const decrypted = row ? await decryptEntry(key, id, { iv: row.iv, ct: row.ct }) : null;
    // The revision is authenticated inside the ciphertext, too.
    const mine = decrypted?.revision === row?.revision ? decrypted : null;
    const stored = {
      settings: mine?.settings ?? null,
      revision: mine?.revision ?? null,
    };
    if (!input) return json({ ...stored, unreadable: row !== null && !mine });
    if (input.revision !== stored.revision) {
      return json({ error: 'Settings changed on another device', ...stored }, 409);
    }
    if (mine && stableStringify(mine.settings) === stableStringify(input.settings)) {
      return json(stored);
    }
    const revision = hex(crypto.getRandomValues(new Uint8Array(16)));
    const entry = await encryptEntry(key, id, { settings: input.settings, revision });
    const at = Date.now();
    // Compare-and-swap in SQL: two concurrent syncs cannot overwrite each other.
    // Compare the ciphertext too, so repairing an unreadable row is safe against races.
    const result = row
      ? await db
          .prepare(
            `UPDATE user_settings SET iv = ?, ct = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND iv = ? AND ct = ?`,
          )
          .bind(entry.iv, entry.ct, revision, at, id, row.revision, row.iv, row.ct)
          .run()
      : await db
          .prepare(
            `INSERT INTO user_settings (id, iv, ct, revision, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          )
          .bind(id, entry.iv, entry.ct, revision, at)
          .run();
    if (result.meta.changes === 1) return json({ settings: input.settings, revision });
  }
  throw new HttpError(409, 'Settings kept changing; try syncing again');
}
