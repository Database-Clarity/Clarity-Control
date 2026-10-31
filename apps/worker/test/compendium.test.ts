import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Fixture, makePrivateKey } from './fixture.js';
let key: string;
let fixture: Fixture;
const calls: { url: string; method: string; body: unknown }[] = [];
let runs: unknown[];
let status: number;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  calls.length = 0;
  runs = [];
  status = 200;
  const original = fixture.fetch.bind(fixture);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.includes('/actions/workflows/')) {
        calls.push({
          url: url.href,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url.pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
        return Response.json({ workflow_runs: runs }, { status });
      }
      return original(input, init);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it('dispatches only the configured workflow repository/ref, and never fetches Google HTML', async () => {
  fixture.env.COMPENDIUM_REPO = 'Compendium-data';
  const response = await fixture.request('/compendium/refresh', 'POST');
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ runId: null });
  expect(calls[0].url).toBe(
    'https://api.github.com/repos/test-org/Compendium-data/actions/workflows/compendium.yml/runs?branch=main&per_page=1',
  );
  expect(calls[1]).toMatchObject({ method: 'POST', body: { ref: 'main' } });
  expect(fixture.googleCalls).toBe(0);
});
it.each([3, 4, 99])('denies refresh/status for role user %s without dispatching', async (id) => {
  expect((await fixture.request('/compendium/refresh', 'POST', undefined, id)).status).toBe(403);
  expect((await fixture.request('/compendium/refresh/status', 'GET', undefined, id)).status).toBe(
    403,
  );
  expect(calls).toHaveLength(0);
});
it('returns progress and reuses an already queued/running refresh', async () => {
  const run = {
    id: 123,
    status: 'in_progress',
    conclusion: null,
    created_at: '2026-10-27T00:00:00Z',
    html_url: 'https://github.com/test-org/Compendium-data/actions/runs/123',
  };
  runs = [run];
  const response = await fixture.request('/compendium/refresh/status');
  expect(await response.json()).toEqual({ run });
  expect((await fixture.request('/compendium/refresh', 'POST')).status).toBe(202);
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});
it('reports completed, unchanged and failed runs without success-shaped fetch fallbacks', async () => {
  runs = [
    {
      id: 1,
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-10-27T00:00:00Z',
      html_url: 'https://github.com/test-org/Compendium-data/actions/runs/1',
    },
  ];
  expect(await (await fixture.request('/compendium/refresh/status')).json()).toMatchObject({
    run: { status: 'completed', conclusion: 'failure' },
  });
  status = 404;
  expect((await fixture.request('/compendium/refresh', 'POST')).status).toBe(502);
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});
