import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import { Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-12T00:00:00Z'));
  fixture = new Fixture(key);
  fixture.env.SITE_ORIGINS = 'https://control.d2clarity.com,https://database-clarity.github.io';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const get = (path: string, cookie?: string) =>
  worker.fetch(
    new Request(`https://api.example${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
    fixture.env,
    { waitUntil: () => {} },
  );
const client = '5d326799-b65d-45f2-a2bf-90bdb90a2721';
it.each([undefined, 'https://control.d2clarity.com', 'https://database-clarity.github.io'])(
  'carries the nonce in signed state and echoes it only in the callback fragment: %s',
  async (site) => {
    const login = await get(
      `/auth/login?client=${client}${site ? `&site=${encodeURIComponent(site)}` : ''}`,
    );
    expect(login.status).toBe(302);
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
    expect(JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString())).toMatchObject({
      client,
    });
    const callback = await get(
      `/auth/callback?state=${encodeURIComponent(state)}&code=code`,
      `clarity_oauth=${state}`,
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('Location')!);
    expect(destination.origin).toBe(site ?? fixture.env.SITE_ORIGIN);
    expect(destination.search).toBe('');
    expect(new URLSearchParams(destination.hash.split('?')[1]).get('client')).toBe(client);
    expect(fixture.subrequests).toBe(2);
  },
);
it.each([
  '',
  'x',
  'a'.repeat(1024),
  `${client}&client=${client}`,
  '%0a',
  `${client}%0a`,
  `${client}%26evil=1`,
])('refuses malformed or oversized clients without a cookie or redirect: %s', async (value) => {
  const response = await get(`/auth/login?client=${value}`);
  expect(response.status).toBe(400);
  expect(response.headers.has('Location')).toBe(false);
  expect(response.headers.has('Set-Cookie')).toBe(false);
  expect(fixture.subrequests).toBe(0);
});
it('rejects a changed client claim even when the state cookie matches the forged state', async () => {
  const login = await get(`/auth/login?client=${client}`);
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
  const [body, signature] = state.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  const tampered = `${Buffer.from(JSON.stringify({ ...claims, client: crypto.randomUUID() })).toString('base64url')}.${signature}`;
  expect(
    (await get(`/auth/callback?state=${tampered}&code=code`, `clarity_oauth=${tampered}`)).status,
  ).toBe(401);
  expect(fixture.subrequests).toBe(0);
});
it('keeps the exact legacy redirect, cookie, and CORS headers without a client', async () => {
  const login = await get('/auth/login');
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
  const expected = new URL('https://github.com/login/oauth/authorize');
  expected.searchParams.set('client_id', fixture.env.GITHUB_CLIENT_ID);
  expected.searchParams.set('redirect_uri', fixture.env.OAUTH_CALLBACK_URL);
  expected.searchParams.set('state', state);
  expect(login.headers.get('Location')).toBe(expected.href);
  expect(login.headers.get('Set-Cookie')).toBe(
    `clarity_oauth=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600; Secure`,
  );
  const response = await get(`/auth/callback?state=${state}&code=code`, `clarity_oauth=${state}`);
  const session = await signToken(
    {
      id: 1,
      login: 'alice',
      purpose: 'session',
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    },
    fixture.env.SESSION_SECRET,
  );
  expect(response.headers.get('Location')).toBe(
    `${fixture.env.SITE_URL}#/auth/callback?session=${encodeURIComponent(session)}`,
  );
  expect(response.headers.get('Set-Cookie')).toBe(
    'clarity_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0; Secure',
  );
  expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  const cors = await worker.fetch(
    new Request('https://api.example/auth/login', { headers: { Origin: fixture.env.SITE_ORIGIN } }),
    fixture.env,
    { waitUntil: () => {} },
  );
  expect(cors.headers.get('Access-Control-Allow-Origin')).toBe(fixture.env.SITE_ORIGIN);
  expect(cors.headers.get('Vary')).toBe('Origin');
});
