import { afterEach, expect, it, vi } from 'vitest';
import { getLegacyHistory, legacyRevisionCache, type LegacyLane } from './legacyHistory';

afterEach(() => vi.unstubAllGlobals());
it('aborts obsolete navigation only after its last consumer leaves', async () => {
  let upstream: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      upstream = init.signal as AbortSignal;
      return new Promise((_resolve, reject) =>
        upstream!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        ),
      );
    }),
  );
  const first = new AbortController(),
    second = new AbortController();
  const request = getLegacyHistory(44, first.signal);
  expect(getLegacyHistory(44, second.signal)).toBe(request);
  first.abort();
  expect(upstream?.aborted).toBe(false);
  second.abort();
  expect(upstream?.aborted).toBe(true);
  await expect(request).rejects.toThrow('Aborted');
  await expect(getLegacyHistory(44, first.signal)).rejects.toThrow('Aborted');
});
const sha = 'a'.repeat(40);
it('keeps an unsignalled consumer alive when a panel navigates away', async () => {
  let upstream: AbortSignal | undefined;
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      upstream = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  const controller = new AbortController();
  const request = getLegacyHistory(45, controller.signal);
  expect(getLegacyHistory(45)).toBe(request);
  controller.abort();
  expect(upstream?.aborted).toBe(false);
  complete(new Response('', { status: 404 }));
  expect(await request).toBeNull();
});
const lane: LegacyLane = {
  hash: 42,
  sourceHash: 42,
  verified: true,
  revisions: [
    {
      commit: sha,
      author: 'Author',
      date: '2024-01-01T00:00:00Z',
      message: 'First',
      text: { en: 'Old' },
    },
    {
      commit: 'b'.repeat(40),
      author: 'Author',
      date: '2024-02-01T00:00:00Z',
      message: 'Delete',
      text: null,
    },
  ],
};
it('compares selected older text to its next published deletion', async () => {
  const cache = legacyRevisionCache(lane);
  const entries = cache.peekPage(1)!;
  const source = await cache.load(entries, 1, 1, false);
  expect(source.revision?.text.en?.text).toBe('Old');
  expect(source.previous).toBeNull();
  expect(source.hasPredecessor).toBe(true);
  expect((await cache.load(entries, 0, 1, false)).hasPredecessor).toBe(false);
});
it('shares concurrent immutable loads, rejects wrong identity, and retries failures', async () => {
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          hash: 42,
          cutoff: sha,
          mappingCommit: sha,
          lanes: [lane],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const first = getLegacyHistory(42);
  expect(getLegacyHistory(42)).toBe(first);
  expect((await first)?.hash).toBe(42);
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(getLegacyHistory(43)).rejects.toThrow('identity mismatch');
  fetch.mockResolvedValue(new Response('', { status: 404 }));
  expect(await getLegacyHistory(43)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);
});
