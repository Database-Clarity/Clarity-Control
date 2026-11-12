import * as z from 'zod/mini';
import { languages } from '../../../../packages/core/src/languageCodes';
import { dropRejectedSession, sessionToken } from './session';
export {
  setSession,
  clearSession,
  subscribeSession,
  rememberSignIn,
  consumePendingSignIn,
} from './session';

/**
 * The Worker URL, authorized requests, sign-in, and `/me`. This is all the public report page
 * needs from the API client, so it stays free of the editor's save and settings schemas and uses
 * zod/mini. services/api.ts re-exports it for the editor.
 */
export const apiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '') || undefined;
const userSchema = z.object({
  id: z.union([z.number(), z.string()]),
  login: z.string(),
  // `partner` (export partners, spec section 4) has no editing role: until the partner pages
  // exist it reads as no role, so every editing control stays off for it.
  role: z.pipe(
    z.nullable(z.enum(['maintainer', 'editor', 'trial', 'translator', 'partner'])),
    z.transform((role) => (role === 'partner' ? null : role)),
  ),
  languages: z.optional(z.array(z.enum(languages))),
  /** Export projects this account is a partner of. */
  projects: z.optional(z.array(z.string())),
});
export type User = z.infer<typeof userSchema>;
export type Me = User;

export function authorization(): Record<string, string> {
  const token = sessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function endpoint(path: string): string {
  if (!apiUrl) throw new Error('VITE_API_URL is not configured. This app is read-only.');
  return `${apiUrl}${path}`;
}

export function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authorization())) headers.set(name, value);
  return fetch(endpoint(path), { ...init, credentials: 'omit', headers });
}

export async function failure(response: Response): Promise<never> {
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
