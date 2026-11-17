import { base64url } from './crypto.js';
import { HttpError } from './http.js';
export const snippetsDomain = 'clarity-user-snippets-v1';
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
let labelKey: { secret: string; key: CryptoKey } | undefined;
async function derive(secret: string, info: string): Promise<ArrayBuffer> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(snippetsDomain),
      info: encoder.encode(info),
    },
    base,
    256,
  );
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Opaque, stable entry id: HMAC-SHA256 keyed by an HKDF-derived server key. */
export async function snippetsAccountId(secret: string, userId: number): Promise<string> {
  const key =
    idKey?.secret === secret
      ? idKey.key
      : await crypto.subtle.importKey(
          'raw',
          await derive(secret, `${snippetsDomain}/file-id`),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
  idKey = { secret, key };
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(userId))));
}

/** Private, account-scoped equality index for atomic case-insensitive label uniqueness. */
export async function snippetsLabelId(
  secret: string,
  account: string,
  label: string,
): Promise<string> {
  const key =
    labelKey?.secret === secret
      ? labelKey.key
      : await crypto.subtle.importKey(
          'raw',
          await derive(secret, `${snippetsDomain}/label-id`),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
  labelKey = { secret, key };
  return hex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${account}:${label.toLowerCase()}`)),
  );
}

/** Server-wide content key; each row authenticates its own user id. */
export async function snippetsKey(secret: string): Promise<CryptoKey> {
  if (contentKey?.secret === secret) return contentKey.key;
  const key = await crypto.subtle.importKey(
    'raw',
    await derive(secret, `${snippetsDomain}/aes-256-gcm`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  contentKey = { secret, key };
  return key;
}

export async function encryptSnippet(key: CryptoKey, aad: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${snippetsDomain}:${aad}`) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: base64url(iv), ct: base64url(new Uint8Array(ct)) };
}
export async function decryptSnippet(
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
        additionalData: encoder.encode(`${snippetsDomain}:${aad}`),
      },
      key,
      unbase64(ct),
    );
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new HttpError(503, 'A snippet could not be read. Try again later.');
  }
}
