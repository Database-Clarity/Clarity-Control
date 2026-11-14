import { afterEach, expect, it, vi } from 'vitest';
import { bundleUrl, inactiveMovesUrl, loadBundle } from './bundle';

const bundle = {
  sourceCommit: 'a'.repeat(40),
  generatedAt: '2026-11-14T00:00:00Z',
  tooltips: {},
  permissions: { users: {} },
  pushed: {},
};
afterEach(() => vi.unstubAllGlobals());
function serve(moves: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === bundleUrl
        ? Response.json(bundle)
        : url.startsWith(inactiveMovesUrl + '?at=')
          ? Response.json(moves, { status })
          : new Response('', { status: 404 }),
    ),
  );
}

it('loads authoritative moves for every role without waiting for a rebuilt bundle', async () => {
  const moves = { 123: { by: 1, at: '2026-11-14T00:00:00Z' } };
  serve(moves);
  expect((await loadBundle()).inactiveMoves).toEqual(moves);
  serve({});
  expect((await loadBundle()).inactiveMoves).toEqual({});
  expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
});

it('treats an absent file as empty, and fails closed on malformed data or upstream failure', async () => {
  serve({}, 404);
  expect((await loadBundle()).inactiveMoves).toEqual({});
  serve({ 123: { by: 'injected' } });
  await expect(loadBundle()).rejects.toThrow();
  serve({}, 502);
  await expect(loadBundle()).rejects.toThrow('502');
});
