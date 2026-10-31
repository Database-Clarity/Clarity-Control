import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import { parseCsv } from '../src/csv.js';
import { Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const context = { waitUntil: () => {} };

describe('sessions and OAuth web flow', () => {
  it('binds state to the browser and redirects with a signed 30-day identity session in the fragment', async () => {
    const response = await worker.fetch(
      new Request('https://api.example/auth/login'),
      fixture.env,
      context,
    );
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get('Location')!);
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(fixture.env.OAUTH_CALLBACK_URL);
    const state = authorize.searchParams.get('state')!;
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly; SameSite=Lax');
    expect(cookie).toContain('Secure');
    const callback = await worker.fetch(
      new Request(
        `https://api.example/auth/callback?state=${encodeURIComponent(state)}&code=code`,
        { headers: { Cookie: cookie.split(';')[0] } },
      ),
      fixture.env,
      context,
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('Location')!);
    expect(destination.origin + destination.pathname).toBe(
      fixture.env.SITE_URL.replace(/\/$/, '/'),
    );
    expect(destination.search).toBe('');
    const token = new URLSearchParams(destination.hash.split('?')[1]).get('session')!;
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ id: 1, login: 'alice', purpose: 'session' });
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeCloseTo(30 * 24 * 3600, -1);
    const me = await worker.fetch(
      new Request('https://api.example/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fixture.env,
      context,
    );
    expect(me.status).toBe(200);
    expect(callback.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('rejects callback state from a different browser and expired state', async () => {
    const login = await worker.fetch(
      new Request('https://api.example/auth/login'),
      fixture.env,
      context,
    );
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
    const url = `https://api.example/auth/callback?state=${encodeURIComponent(state)}&code=code`;
    expect((await worker.fetch(new Request(url), fixture.env, context)).status).toBe(401);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601000);
    expect(
      (
        await worker.fetch(
          new Request(url, {
            headers: { Cookie: `clarity_oauth=${state}` },
          }),
          fixture.env,
          context,
        )
      ).status,
    ).toBe(401);
  });

  it.each(['missing', 'tampered', 'expired', 'wrong-purpose'])(
    'rejects %s session tokens',
    async (kind) => {
      let token = await signToken(
        {
          id: 1,
          login: 'alice',
          purpose: kind === 'wrong-purpose' ? 'oauth' : 'session',
          exp: Math.floor(Date.now() / 1000) + (kind === 'expired' ? -1 : 100),
        },
        fixture.env.SESSION_SECRET,
      );
      if (kind === 'tampered') token = `x${token}`;
      const result = await worker.fetch(
        new Request('https://api.example/me', {
          headers: kind === 'missing' ? {} : { Authorization: `Bearer ${token}` },
        }),
        fixture.env,
        context,
      );
      expect(result.status).toBe(401);
    },
  );

  it('does not accept an untrusted Origin or reflect it in CORS headers', async () => {
    const response = await worker.fetch(
      new Request('https://api.example/auth/login', {
        headers: { Origin: 'https://evil.example' },
      }),
      fixture.env,
      context,
    );
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const local = await worker.fetch(
      new Request('https://api.example/save', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      }),
      fixture.env,
      context,
    );
    expect(local.status).toBe(204);
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(local.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    const unauthenticated = await worker.fetch(
      new Request('https://api.example/save', {
        method: 'POST',
        headers: { Origin: fixture.env.SITE_ORIGIN },
        body: '{}',
      }),
      fixture.env,
      context,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('Access-Control-Allow-Origin')).toBe(
      fixture.env.SITE_ORIGIN,
    );
  });
});

describe('quoted multiline CSV', () => {
  it.each([
    ['', []],
    [
      'a,b\r\nc,d\r\n',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    ['\uFEFF"a","line 1\nline 2, ""quoted""",\r\n', [['a', 'line 1\nline 2, "quoted"', '']]],
    [',', [['', '']]],
    ['""', [['']]],
    ['a\n\nb', [['a'], [''], ['b']]],
    ['"a\r\nb",c', [['a\r\nb', 'c']]],
  ])('parses CSV %j', (csv, rows) => {
    expect(parseCsv(csv)).toEqual(rows);
  });

  it.each(['"open', '"closed"x', 'a"b', '"a" "b"'])('rejects malformed CSV %j', (csv) => {
    expect(() => parseCsv(csv)).toThrow();
  });
});
