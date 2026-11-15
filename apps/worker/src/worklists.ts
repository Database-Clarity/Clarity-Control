import { z } from 'zod';
import {
  storedWorklistSchema,
  worklistIdSchema,
  worklistsBodyLimit,
  worklistNameSchema,
} from '../../../packages/core/src/worklists.js';
import { base64url } from './crypto.js';
import type { GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

export const worklistsDomain = 'clarity-user-worklists-v1';
const encoder = new TextEncoder();
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}
// Cache only server-derived CryptoKeys, as crypto.ts does; no account data or request I/O.
let idKey: { secret: string; key: CryptoKey } | undefined;
let contentKey: { secret: string; key: CryptoKey } | undefined;
async function derive(secret: string, info: string): Promise<ArrayBuffer> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(worklistsDomain),
      info: encoder.encode(info),
    },
    base,
    256,
  );
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Opaque, stable entry id: HMAC-SHA256 keyed by an HKDF-derived server key. */
export async function worklistsFileId(secret: string, userId: number): Promise<string> {
  const key =
    idKey?.secret === secret
      ? idKey.key
      : await crypto.subtle.importKey(
          'raw',
          await derive(secret, `${worklistsDomain}/file-id`),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
  idKey = { secret, key };
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(userId))));
}

/** Server-wide content key; each row authenticates its own user id. */
export async function worklistsKey(secret: string): Promise<CryptoKey> {
  if (contentKey?.secret === secret) return contentKey.key;
  const key = await crypto.subtle.importKey(
    'raw',
    await derive(secret, `${worklistsDomain}/aes-256-gcm`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  contentKey = { secret, key };
  return key;
}

interface Row {
  id: string;
  meta_iv: string;
  meta_ct: string;
  iv: string;
  ct: string;
  revision: string;
}
const revisionSchema = z.string().regex(/^[0-9a-f]{32}$/);
const metaSchema = z.object({
  name: worklistNameSchema,
  count: z.number().int().nonnegative().max(500),
  updatedAt: z.number().int().nonnegative(),
  revision: revisionSchema,
});
const plainSchema = storedWorklistSchema.extend({ revision: revisionSchema });
const putSchema = storedWorklistSchema.extend({ revision: revisionSchema.nullable() }).strict();
const deleteSchema = z.object({ revision: revisionSchema }).strict();

export async function encryptWorklist(key: CryptoKey, aad: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${worklistsDomain}:${aad}`) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: base64url(iv), ct: base64url(new Uint8Array(ct)) };
}
export async function decryptWorklist(
  key: CryptoKey,
  aad: string,
  iv: string,
  ct: string,
): Promise<unknown> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unbase64(iv),
        additionalData: encoder.encode(`${worklistsDomain}:${aad}`),
      },
      key,
      unbase64(ct),
    );
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new HttpError(503, 'A worklist could not be read. Your local copy is kept.');
  }
}

/** One encrypted row per account/list. The index never selects entry ciphertexts. */
export async function userWorklists(
  request: Request,
  github: GitHub,
  user: Identity,
  listId?: string,
): Promise<Response> {
  requireAccess(await permissions(github, await github.head()), user, [
    'maintainer',
    'editor',
    'trial',
    'translator',
  ]);
  const db = github.env.SETTINGS_DB;
  if (!db) throw new HttpError(503, 'Worklists are unavailable');
  const account = await worklistsFileId(github.env.SESSION_SECRET, user.id);
  const key = await worklistsKey(github.env.SESSION_SECRET);
  if (listId === undefined) {
    if (request.method !== 'GET') throw new HttpError(405, 'Choose a worklist to save');
    // JSON aggregation uses the same narrow D1 contract as settings, and reads only metadata.
    const index = await db
      .prepare(
        `SELECT json_group_array(json_object('id', id, 'meta_iv', meta_iv, 'meta_ct', meta_ct, 'revision', revision)) AS rows FROM user_worklists WHERE account_id = ?`,
      )
      .bind(account)
      .first<{ rows: string }>();
    const rows = JSON.parse(index?.rows ?? '[]') as Pick<
      Row,
      'id' | 'meta_iv' | 'meta_ct' | 'revision'
    >[];
    const lists = await Promise.all(
      rows.map(async (row) => {
        const meta = metaSchema.parse(
          await decryptWorklist(key, `${account}:${row.id}:meta`, row.meta_iv, row.meta_ct),
        );
        if (meta.revision !== row.revision)
          throw new HttpError(503, 'Worklist index could not be authenticated');
        return { id: row.id, ...meta };
      }),
    );
    return json({ lists });
  }
  if (!worklistIdSchema.safeParse(listId).success) throw new HttpError(400, 'Invalid worklist id');
  const raw =
    request.method !== 'GET' ? await body(request, z.unknown(), worklistsBodyLimit) : null;
  const parsed = request.method === 'PUT' ? putSchema.safeParse(raw) : null;
  if (parsed && !parsed.success)
    throw new HttpError(
      400,
      'Worklists allow 500 entries and 16 KB of unique entry hashes and names of 1–80 characters.',
      parsed.error.issues,
    );
  const input = parsed?.success ? parsed.data : null;
  const deletion = request.method === 'DELETE' ? deleteSchema.parse(raw) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare(
        'SELECT id, meta_iv, meta_ct, iv, ct, revision FROM user_worklists WHERE account_id = ? AND id = ?',
      )
      .bind(account, listId)
      .first<Row>();
    const plain = row
      ? plainSchema.parse(await decryptWorklist(key, `${account}:${listId}:items`, row.iv, row.ct))
      : null;
    if (row && plain?.revision !== row.revision)
      throw new HttpError(503, 'Worklist revision could not be authenticated');
    const stored = {
      worklist: plain ? { id: listId, name: plain.name, hashes: plain.hashes } : null,
      revision: plain?.revision ?? null,
    };
    if (request.method === 'GET') return json(stored);
    if ((input ? input.revision : (deletion?.revision ?? null)) !== stored.revision)
      return json({ error: 'Worklist changed on another device', ...stored }, 409);
    if (deletion) {
      const result = await db
        .prepare(
          'DELETE FROM user_worklists WHERE account_id = ? AND id = ? AND revision = ? AND ct = ?',
        )
        .bind(account, listId, deletion.revision, row!.ct)
        .run();
      if (result.meta.changes === 1) return json({ worklist: null, revision: null });
      continue;
    }
    if (!input) throw new HttpError(405, 'Unsupported method');
    if (
      plain &&
      plain.name === input.name &&
      JSON.stringify(plain.hashes) === JSON.stringify(input.hashes)
    )
      return json(stored);
    const revision = hex(crypto.getRandomValues(new Uint8Array(16)));
    const entry = await encryptWorklist(key, `${account}:${listId}:items`, {
      name: input.name,
      hashes: input.hashes,
      revision,
    });
    const meta = await encryptWorklist(key, `${account}:${listId}:meta`, {
      name: input.name,
      count: input.hashes.length,
      updatedAt: Date.now(),
      revision,
    });
    const result = row
      ? await db
          .prepare(
            'UPDATE user_worklists SET meta_iv = ?, meta_ct = ?, iv = ?, ct = ?, revision = ? WHERE account_id = ? AND id = ? AND revision = ? AND ct = ?',
          )
          .bind(
            meta.iv,
            meta.ct,
            entry.iv,
            entry.ct,
            revision,
            account,
            listId,
            row.revision,
            row.ct,
          )
          .run()
      : await db
          .prepare(
            `INSERT INTO user_worklists (account_id, id, meta_iv, meta_ct, iv, ct, revision)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM user_worklists WHERE account_id = ?) < 50
          ON CONFLICT(account_id, id) DO NOTHING`,
          )
          .bind(account, listId, meta.iv, meta.ct, entry.iv, entry.ct, revision, account)
          .run();
    if (result.meta.changes === 1)
      return json({ worklist: { id: listId, name: input.name, hashes: input.hashes }, revision });
    if (!row) {
      const concurrent = await db
        .prepare('SELECT revision FROM user_worklists WHERE account_id = ? AND id = ?')
        .bind(account, listId)
        .first<{ revision: string }>();
      if (!concurrent) throw new HttpError(400, 'An account can save up to 50 worklists');
    }
  }
  throw new HttpError(409, 'Worklist kept changing. Retry sync.');
}
