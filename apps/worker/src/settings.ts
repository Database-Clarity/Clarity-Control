import { z } from 'zod';
import {
  settingsBodyLimit,
  stableStringify,
  syncedSettingsSchema,
  type SyncedSettings,
} from '@clarity/core';
import { base64url, unbase64 } from './crypto.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

/**
 * Synced user settings, stored in the PUBLIC data repository without naming the user:
 * - path `user-settings/<HMAC-SHA256(file-id key, user id)>.json`;
 * - content `{ v, iv, ct }`: AES-256-GCM with a random 96-bit nonce, plaintext padded to a
 *   multiple of 256 bytes, the file id bound as associated data;
 * - both keys come from HKDF-SHA256 over SESSION_SECRET, salt and info domain-separated by
 *   `clarity-user-settings-v1`, so no new secret is needed;
 * - commits are authored and committed by the App bot with a fixed message.
 */
export const settingsDomain = 'clarity-user-settings-v1';
export const settingsDirectory = 'user-settings';
const encoder = new TextEncoder();
const padding = 256;

const envelopeSchema = z
  .object({
    v: z.literal(1),
    iv: z.string().regex(/^[\w-]{16}$/),
    ct: z
      .string()
      .regex(/^[\w-]+$/)
      .max(4096),
  })
  .strict();
const putSchema = z
  .object({
    settings: syncedSettingsSchema,
    revision: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
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

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Opaque, stable file id: HMAC-SHA256 keyed by an HKDF-derived server key. */
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

async function userKey(secret: string, userId: number): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    await derive(secret, `${settingsDomain}/aes-256-gcm/${userId}`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

const associatedData = (fileId: string) => encoder.encode(`${settingsDomain}:${fileId}`);

export async function encryptSettings(
  secret: string,
  userId: number,
  fileId: string,
  settings: SyncedSettings,
): Promise<z.infer<typeof envelopeSchema>> {
  const text = JSON.stringify(settings);
  const plain = encoder.encode(text.padEnd(Math.ceil((text.length + 1) / padding) * padding, ' '));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(fileId) },
    await userKey(secret, userId),
    plain,
  );
  return { v: 1, iv: base64url(iv), ct: base64url(new Uint8Array(ct)) };
}

/** `null` when the stored bytes are not a valid, authentic envelope for this user. */
export async function decryptSettings(
  secret: string,
  userId: number,
  fileId: string,
  stored: unknown,
): Promise<SyncedSettings | null> {
  const envelope = envelopeSchema.safeParse(stored);
  if (!envelope.success) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unbase64(envelope.data.iv),
        additionalData: associatedData(fileId),
      },
      await userKey(secret, userId),
      unbase64(envelope.data.ct),
    );
    const result = syncedSettingsSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Git blob SHA of the file `GitHub.commit` writes, so PUT can return the new revision. */
async function blobSha(value: unknown): Promise<string> {
  const content = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
  const header = encoder.encode(`blob ${content.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + content.byteLength);
  bytes.set(header);
  bytes.set(content, header.byteLength);
  return hex(await crypto.subtle.digest('SHA-1', bytes));
}

async function current(github: GitHub, user: Identity, path: string, fileId: string, head: string) {
  const file = await github.file(path, head);
  if (!file) return { settings: null, revision: null, unreadable: false };
  const settings = await decryptSettings(github.env.SESSION_SECRET, user.id, fileId, file.value);
  return { settings, revision: file.sha, unreadable: settings === null };
}

/**
 * GET returns `{ settings, revision, unreadable }`; PUT `{ settings, revision }` writes when
 * `revision` matches the stored file (null = none yet), else 409 with the stored copy.
 * Any user with an editing role may sync; others keep settings in the browser.
 */
export async function userSettings(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const input = request.method === 'PUT' ? await body(request, putSchema, settingsBodyLimit) : null;
  const fileId = await settingsFileId(github.env.SESSION_SECRET, user.id);
  const path = `${settingsDirectory}/${fileId}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    requireAccess(await permissions(github, head), user, [
      'maintainer',
      'editor',
      'trial',
      'translator',
    ]);
    const stored = await current(github, user, path, fileId, head);
    if (!input) return json(stored);
    if (input.revision !== stored.revision) {
      return json(
        {
          error: 'Settings changed on another device',
          settings: stored.settings,
          revision: stored.revision,
        },
        409,
      );
    }
    if (stored.settings && stableStringify(stored.settings) === stableStringify(input.settings)) {
      return json({ settings: stored.settings, revision: stored.revision });
    }
    const envelope = await encryptSettings(
      github.env.SESSION_SECRET,
      user.id,
      fileId,
      input.settings,
    );
    try {
      await github.commit(head, { [path]: envelope }, 'Update synced settings', null);
      return json({ settings: input.settings, revision: await blobSha(envelope) });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; try syncing again');
}
