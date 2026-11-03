import { z } from 'zod';
import { HttpError } from './http.js';

const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}

let hmacCache: { secret: string; key: CryptoKey } | undefined;
let rsaCache: { pem: string; key: CryptoKey } | undefined;

async function hmac(secret: string) {
  if (hmacCache?.secret === secret) return hmacCache.key;
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  hmacCache = { secret, key };
  return key;
}

export async function signToken(payload: object, secret: string): Promise<string> {
  const value = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmac(secret), encoder.encode(value));
  return `${value}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyToken<T>(
  token: string,
  secret: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const key = await hmac(secret);
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[\w-]+$/.test(part))) {
    throw new HttpError(401, 'Invalid or expired token');
  }
  let signature: Uint8Array<ArrayBuffer>;
  let parsed: unknown;
  try {
    signature = unbase64(parts[1]);
    parsed = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  if (!(await crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts[0])))) {
    throw new HttpError(401, 'Invalid or expired token');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(401, 'Invalid or expired token');
  return result.data;
}

export async function appJwt(id: string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id })),
  );
  let key = rsaCache?.pem === pem ? rsaCache.key : undefined;
  if (!key) {
    const der = unbase64(pem.replaceAll('\\n', '\n').replace(/-----[^-]+-----|\s/g, ''));
    key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    rsaCache = { pem, key };
  }
  const value = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(value));
  return `${value}.${base64url(new Uint8Array(signature))}`;
}
