import { z } from 'zod';
import { settingsBodyLimit, stableStringify, syncedSettingsSchema } from '@clarity/core';
import { base64url, unbase64 } from './crypto.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Env, Identity } from './types.js';

/**
 * Synced user settings, stored in the PUBLIC repository without revealing who synced what:
 * - a separate branch (`SETTINGS_BRANCH`, default `editor-settings`), so settings writes never
 *   move the data branch tooltip saves use; it is created on the first sync;
 * - one file, `settings.json`: `{ v: 1, entries: { <HMAC-SHA256(id key, user id)>: { iv, ct } } }`;
 * - every entry is AES-256-GCM under ONE server-wide key, with its entry id as associated data
 *   and a plaintext padded to a fixed 512-byte bucket, so all entries have the same size;
 * - every sync re-encrypts EVERY entry with fresh nonces in one commit, so each commit changes
 *   every entry and does not reveal whose settings changed;
 * - commits use the App bot as author and committer, a fixed message and a date rounded down
 *   to the UTC hour;
 * - both keys come from HKDF-SHA256 over SESSION_SECRET, domain-separated by
 *   `clarity-user-settings-v1`, so no new secret is needed.
 * The per-user `revision` lives inside the ciphertext, so other users' syncs (which rewrite
 * every entry) never look like conflicts.
 */
export const settingsDomain = 'clarity-user-settings-v1';
export const settingsFile = 'settings.json';
export const defaultSettingsBranch = 'editor-settings';
export const settingsBucket = 512;
const encoder = new TextEncoder();

export const settingsBranch = (env: Env) => env.SETTINGS_BRANCH || defaultSettingsBranch;

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
const storeSchema = z
  .object({
    v: z.literal(1),
    entries: z.record(z.string().regex(/^[0-9a-f]{64}$/), z.unknown()),
  })
  .strict();
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

/** The one server-wide content key; lets the Worker re-encrypt every entry on each sync. */
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
  const text = JSON.stringify(plain);
  const size = Math.max(1, Math.ceil(encoder.encode(text).byteLength / settingsBucket));
  const padded = encoder.encode(text.padEnd(size * settingsBucket, ' '));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(id) },
    key,
    padded,
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

/** Commit time rounded down to the UTC hour (git metadata only; see the report). */
export const coarseDate = (now = Date.now()) =>
  new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString().replace('.000Z', 'Z');

async function load(github: GitHub, key: CryptoKey) {
  const branch = settingsBranch(github.env);
  const head = await github.headOrNull(branch);
  const file = head ? await github.file(settingsFile, head) : null;
  const store = storeSchema.safeParse(file?.value);
  const entries = store.success ? store.data.entries : {};
  const plain = new Map<string, Plain | null>();
  for (const [id, entry] of Object.entries(entries))
    plain.set(id, await decryptEntry(key, id, entry));
  return { branch, head, plain };
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
  for (let attempt = 0; attempt < 3; attempt++) {
    requireAccess(await permissions(github, await github.head()), user, [
      'maintainer',
      'editor',
      'trial',
      'translator',
    ]);
    const { branch, head, plain } = await load(github, key);
    const mine = plain.get(id) ?? null;
    const stored = {
      settings: mine?.settings ?? null,
      revision: mine?.revision ?? null,
    };
    if (!input) return json({ ...stored, unreadable: plain.has(id) && !mine });
    if (input.revision !== stored.revision) {
      return json({ error: 'Settings changed on another device', ...stored }, 409);
    }
    if (mine && stableStringify(mine.settings) === stableStringify(input.settings)) {
      return json(stored);
    }
    const revision = hex(crypto.getRandomValues(new Uint8Array(16)));
    plain.set(id, { settings: input.settings, revision });
    // Re-encrypt every readable entry with a fresh nonce; unreadable ones are dropped.
    const entries: Record<string, SettingsEntry> = {};
    for (const entryId of [...plain.keys()].sort()) {
      const value = plain.get(entryId);
      if (value) entries[entryId] = await encryptEntry(key, entryId, value);
    }
    try {
      await github.commitAsBot(
        branch,
        head,
        { [settingsFile]: { v: 1, entries } },
        'Update synced settings',
        coarseDate(),
      );
      return json({ settings: input.settings, revision });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Settings branch kept moving; try syncing again');
}
