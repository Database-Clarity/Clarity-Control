// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.signature';
const commit = 'a'.repeat(40);
const tooltip = { hash: 123, text: {}, associated: [] };
describe('history and publishing client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    vi.stubGlobal('sessionStorage', { getItem: () => session });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('authenticates paginated history and immutable versions without URL tokens', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          page: 2,
          commits: [{ commit, author: 'alice', date: null, message: 'edit' }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ commit, tooltip }))
      .mockResolvedValueOnce(Response.json({ pushedHash: null, tooltip: null }));
    vi.stubGlobal('fetch', fetch);
    const { getHistory, getVersion, getPushedVersion } = await import('./history');
    expect((await getHistory(123, 2)).page).toBe(2);
    expect((await getVersion(123, commit)).tooltip).toEqual(tooltip);
    expect(await getPushedVersion(123)).toEqual({ pushedHash: null, tooltip: null });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://worker.example/history/123?page=2',
      `https://worker.example/history/123?commit=${commit}`,
      'https://worker.example/history/123?live=1',
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
    });
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe(
      `Bearer ${session}`,
    );
  });
  it('sends selections and reviewed digests, validates push success', async () => {
    const pushed = { 123: 'b'.repeat(64) };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ commit, liveCommit: commit, pushed, branch: 'test-live' }),
      );
    vi.stubGlobal('fetch', fetch);
    const { pushSelected } = await import('./history');
    expect((await pushSelected([123], pushed)).pushed).toEqual(pushed);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ hashes: [123], expected: pushed }),
    });
  });
  it('surfaces partial-live-write details and malformed responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { error: 'Marker failed', details: { liveCommit: commit, pushedRecorded: false } },
            { status: 409 },
          ),
        )
        .mockResolvedValueOnce(Response.json({ tooltip: 'invalid' })),
    );
    const { pushSelected, getPushedVersion } = await import('./history');
    await expect(pushSelected([123], {})).rejects.toThrow('pushedRecorded');
    await expect(getPushedVersion(123)).rejects.toThrow();
  });
  it('does not fetch without API configuration and forwards cancellation', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetch);
    let history = await import('./history');
    const controller = new AbortController();
    controller.abort();
    await expect(history.getHistory(123, 1, controller.signal)).rejects.toThrow('Aborted');
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', '');
    history = await import('./history');
    await expect(history.getHistory(123)).rejects.toThrow('not configured');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
