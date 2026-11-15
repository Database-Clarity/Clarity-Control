import { writeFileSync } from 'node:fs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { GitHub } from '../src/github.js';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import { Fixture, makePrivateKey, sha, tooltip } from './fixture.js';

let key: string;
beforeAll(async () => {
  key = await makePrivateKey();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('isolates immutable files by head, path, repository, and size mode, and returns private copies', async () => {
  const fixture = new Fixture(key);
  const github = new GitHub(fixture.env);
  const first = await github.file('tooltips/123.json', fixture.dataHead);
  first!.value = null;
  expect((await github.file('tooltips/123.json', fixture.dataHead))!.value).toEqual(tooltip());
  expect((await github.file('tooltips/123.json', fixture.dataHead, true))!.size).toBeGreaterThan(0);
  expect(await github.file('tooltips/124.json', fixture.dataHead)).toBeNull();
  fixture.moveData({ 'tooltips/123.json': tooltip('new') });
  expect((await github.file('tooltips/123.json', fixture.dataHead))!.value).toEqual(tooltip('new'));
  const read = vi.fn(async () => 'first');
  expect(await github.immutable('same', read)).toBe('first');
  const other = new GitHub({ ...fixture.env, GITHUB_REPO: 'other' });
  expect(await other.immutable('same', async () => 'other')).toBe('other');
  expect(await github.immutable('same', read)).toBe('first');
  expect(read).toHaveBeenCalledTimes(1);
});

it('bounds entry count and bytes, and evicts least recently used data', async () => {
  const github = new GitHub(new Fixture(key).env);
  const read = vi.fn(async () => 'original');
  await github.immutable('oldest', read);
  for (let i = 0; i < 256; i++) await github.immutable(String(i), async () => i);
  await github.immutable('oldest', read);
  expect(read).toHaveBeenCalledTimes(2);
  const huge = vi.fn(async () => 'x'.repeat(3 * 1024 * 1024));
  await github.immutable('oversized', huge);
  await github.immutable('oversized', huge);
  expect(huge).toHaveBeenCalledTimes(2);
  const failed = vi.fn(async () => {
    throw new Error('retry');
  });
  await expect(github.immutable('failed', failed)).rejects.toThrow('retry');
  await expect(github.immutable('failed', failed)).rejects.toThrow('retry');
  expect(failed).toHaveBeenCalledTimes(2);
});

it('reuses tokens only for the same binding context and scopes, and refreshes before expiry', async () => {
  const fixture = new Fixture(key);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const upstream = globalThis.fetch;
  let tokens = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/access_tokens')) {
      tokens++;
      return Response.json({
        token: 'installation-token',
        expires_at: new Date(now + 3600_000).toISOString(),
      });
    }
    return upstream(input, init);
  });
  const first = new GitHub(fixture.env);
  await first.head();
  await new GitHub(fixture.env).head();
  expect(tokens).toBe(1);
  await new GitHub(fixture.env, { contents: 'read' }).head();
  expect(tokens).toBe(2);
  now += 3540_000;
  await first.head();
  expect(tokens).toBe(3);
  await new GitHub({ ...fixture.env, GITHUB_APP_ID: 'another' }).head();
  expect(tokens).toBe(4);
  expect(await first.head()).toBe(sha(1));
});

// Opt-in local CPU proxy: resolved in-memory upstream, no network waits. Includes fixture
// response construction is subtracted, and the client session is signed before timing.
it.runIf(process.env.LIVE_CACHE_CPU === '1')(
  'measures cold and warm review route CPU',
  async () => {
    const fixture = new Fixture(key);
    const markers = Object.fromEntries(
      Array.from({ length: 2900 }, (_, i) => [i + 100, 'a'.repeat(64)]),
    );
    fixture.moveData({ 'live/pushed.json': markers, 'live/tooltips/123.json': tooltip() });
    const upstream = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/access_tokens'))
        return Response.json({
          token: 'installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      return upstream(input, init);
    });
    const session = await signToken(
      { id: 1, login: 'alice', purpose: 'session', exp: Math.floor(Date.now() / 1000) + 3600 },
      fixture.env.SESSION_SECRET,
    );
    let mockMs = 0;
    const mocked = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const start = performance.now();
      const response = await mocked(input, init);
      mockMs += performance.now() - start;
      return response;
    });
    const times: number[] = [];
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      mockMs = 0;
      const response = await worker.fetch(
        new Request('https://api.example/history/123?live=1', {
          headers: { Authorization: `Bearer ${session}`, Origin: fixture.env.SITE_ORIGIN },
        }),
        fixture.env,
        { waitUntil: (promise) => fixture.pending.push(promise) },
      );
      expect(response.status).toBe(200);
      await response.json();
      times.push(performance.now() - start - mockMs);
    }
    const result = {
      markerBytes: JSON.stringify(markers).length,
      coldMs: times[0],
      warmMs: times.slice(1),
      warmMaxMs: Math.max(...times.slice(1)),
    };
    console.log(JSON.stringify(result));
    if (process.env.LIVE_CACHE_CPU_OUTPUT) {
      writeFileSync(process.env.LIVE_CACHE_CPU_OUTPUT, JSON.stringify(result, null, 2));
    }
  },
);
