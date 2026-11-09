import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { siteOrigins } from '../src/auth.js';
import { Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  fixture.env.SITE_ORIGINS = 'https://editor.example,https://control.example';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const context = { waitUntil: () => {} };
const get = (path: string, headers: Record<string, string> = {}, env = fixture.env) =>
  worker.fetch(new Request(`https://api.example${path}`, { headers }), env, context);
const payload = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

async function signIn(site?: string) {
  const login = await get(
    `/auth/login${site === undefined ? '' : `?site=${encodeURIComponent(site)}`}`,
  );
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
  const cookie = login.headers.get('Set-Cookie')!;
  return { login, state, cookie };
}

describe('old origin is unchanged by the site allow-list', () => {
  it.each([undefined, 'https://editor.example'])(
    'sign-in with site=%s: same authorize URL, cookie, state shape and return target as before',
    async (site) => {
      const { login, state, cookie } = await signIn(site);
      expect(login.status).toBe(302);
      const authorize = new URL(login.headers.get('Location')!);
      expect(authorize.origin + authorize.pathname).toBe(
        'https://github.com/login/oauth/authorize',
      );
      expect([...authorize.searchParams.keys()].sort()).toEqual([
        'client_id',
        'redirect_uri',
        'state',
      ]);
      expect(authorize.searchParams.get('client_id')).toBe('client');
      expect(authorize.searchParams.get('redirect_uri')).toBe('https://api.example/auth/callback');
      expect(cookie).toBe(
        `clarity_oauth=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600; Secure`,
      );
      expect(login.headers.get('Cache-Control')).toBe('no-store');
      // No `site` claim: the state is exactly what it was before the allow-list existed.
      expect(Object.keys(payload(state)).sort()).toEqual(['exp', 'nonce', 'purpose']);

      const callback = await get(`/auth/callback?state=${encodeURIComponent(state)}&code=code`, {
        Cookie: cookie.split(';')[0],
      });
      expect(callback.status).toBe(302);
      const location = callback.headers.get('Location')!;
      expect(location.startsWith('https://editor.example/app/#/auth/callback?session=')).toBe(true);
      expect(callback.headers.get('Set-Cookie')).toBe(
        'clarity_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0; Secure',
      );
      expect(callback.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(callback.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it("CORS for the old origin and localhost has exactly today's headers", async () => {
    for (const origin of ['https://editor.example', 'http://localhost:5173']) {
      const response = await worker.fetch(
        new Request('https://api.example/save', { method: 'OPTIONS', headers: { Origin: origin } }),
        fixture.env,
        context,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Authorization, Content-Type',
      );
      expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
      expect(response.headers.get('Vary')).toBe('Origin');
    }
  });

  it('without SITE_ORIGINS only the primary origin and localhost are allowed', async () => {
    delete fixture.env.SITE_ORIGINS;
    expect(siteOrigins(fixture.env)).toEqual(['https://editor.example']);
    const other = await get('/auth/login', { Origin: 'https://control.example' });
    expect(other.status).toBe(403);
    expect((await get('/auth/login?site=https://control.example')).status).toBe(400);
  });
});

describe('second site (control.example)', () => {
  it('sign-in started there returns there, with the session in the fragment', async () => {
    const { state, cookie } = await signIn('https://control.example');
    expect(payload(state)).toMatchObject({ purpose: 'oauth', site: 'https://control.example' });
    const callback = await get(`/auth/callback?state=${encodeURIComponent(state)}&code=code`, {
      Cookie: cookie.split(';')[0],
    });
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('Location')!);
    expect(destination.origin + destination.pathname).toBe('https://control.example/');
    expect(destination.search).toBe('');
    const token = new URLSearchParams(destination.hash.split('?')[1]).get('session')!;
    expect(payload(token)).toMatchObject({ id: 1, login: 'alice', purpose: 'session' });
    const me = await get('/me', { Authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
  });

  it('is allowed by CORS and echoed; an unlisted origin is still refused', async () => {
    const allowed = await worker.fetch(
      new Request('https://api.example/save', {
        method: 'OPTIONS',
        headers: { Origin: 'https://control.example' },
      }),
      fixture.env,
      context,
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://control.example');
    const refused = await get('/me', { Origin: 'https://control.example.evil' });
    expect(refused.status).toBe(403);
    expect(refused.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});

describe('rejected return targets', () => {
  it.each([
    'https://evil.example',
    'https://control.example/',
    'https://control.example/path',
    'https://control.example.evil',
    'http://control.example',
    'https://control.example:8443',
    'javascript:alert(1)',
    '',
  ])('login with site=%j is 400 with no redirect and no cookie', async (site) => {
    const response = await get(`/auth/login?site=${encodeURIComponent(site)}`);
    expect(response.status).toBe(400);
    expect(response.headers.has('Location')).toBe(false);
    expect(response.headers.has('Set-Cookie')).toBe(false);
  });

  it('a tampered state (site swapped, signature kept) is rejected before any GitHub call', async () => {
    const { state } = await signIn('https://control.example');
    const [body, signature] = state.split('.');
    const forged = {
      ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      site: 'https://evil.example',
    };
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    const before = fixture.subrequests;
    const response = await get(`/auth/callback?state=${encodeURIComponent(tampered)}&code=code`, {
      Cookie: `clarity_oauth=${tampered}`,
    });
    expect(response.status).toBe(401);
    expect(response.headers.has('Location')).toBe(false);
    expect(fixture.subrequests).toBe(before);
  });

  it('a site removed from the list after sign-in started is 400 with no GitHub call', async () => {
    const { state, cookie } = await signIn('https://control.example');
    fixture.env.SITE_ORIGINS = 'https://editor.example';
    const response = await get(`/auth/callback?state=${encodeURIComponent(state)}&code=code`, {
      Cookie: cookie.split(';')[0],
    });
    expect(response.status).toBe(400);
    expect(response.headers.has('Location')).toBe(false);
    expect(fixture.subrequests).toBe(0);
  });

  it('ignores malformed allow-list entries instead of trusting them', () => {
    fixture.env.SITE_ORIGINS =
      ' https://control.example , not a url, https://x.example/path, ftp://x.example, ,*, http://plain.example, https://*.example, http://localhost:3000';
    expect(siteOrigins(fixture.env)).toEqual([
      'https://editor.example',
      'https://control.example',
      'http://localhost:3000',
    ]);
  });
});
