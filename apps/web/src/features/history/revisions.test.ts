import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createRevisionCache } from './revisions';
const getHistory = vi.fn();
const getVersion = vi.fn();
vi.mock('../../services/history', () => ({
  getHistory: (...args: unknown[]) => getHistory(...args),
  getVersion: (...args: unknown[]) => getVersion(...args),
}));
const commits = [{ commit: 'a' }, { commit: 'b' }] as never;
beforeEach(() => {
  getHistory.mockReset().mockResolvedValue({ commits });
  getVersion
    .mockReset()
    .mockImplementation((_hash, commit) => Promise.resolve({ tooltip: { commit } }));
});
afterEach(() => vi.useRealTimers());
it('shares the first page between the count, content, and reopening the panel', async () => {
  const cache = createRevisionCache(10);
  const count = cache.page(1);
  expect(cache.page(1)).toBe(count);
  await count;
  expect(cache.peekPage(1)).toBe(commits);
  await cache.page(1);
  expect(getHistory).toHaveBeenCalledTimes(1);
});
it('refreshes expired pages on open and retries failures', async () => {
  vi.useFakeTimers();
  const cache = createRevisionCache(10);
  await cache.page(1);
  vi.advanceTimersByTime(60_001);
  getHistory.mockRejectedValueOnce(Error('offline'));
  await expect(cache.page(1)).rejects.toThrow('offline');
  await cache.page(1);
  expect(getHistory).toHaveBeenCalledTimes(3);
});
it('bounds immutable revision bodies and keeps recently used revisions', async () => {
  const cache = createRevisionCache(10);
  for (let i = 0; i < 24; i++) await cache.version(String(i));
  await cache.version('0');
  await cache.version('24');
  await cache.version('0');
  expect(getVersion).toHaveBeenCalledTimes(25);
  await cache.version('1');
  expect(getVersion).toHaveBeenCalledTimes(26);
});
it('fetches the previous page boundary only on demand and shares adjacent revisions', async () => {
  const cache = createRevisionCache(10);
  await cache.load(commits, 0, 1, true);
  expect(getHistory).not.toHaveBeenCalled();
  getHistory.mockResolvedValueOnce({ commits: [{ commit: 'c' }] });
  await cache.load(commits, 1, 1, true);
  expect(getHistory).toHaveBeenCalledWith(10, 2, expect.any(AbortSignal));
  expect(getVersion).toHaveBeenCalledTimes(3);
});

it('keeps stale rows and coalesces concurrent refreshes', async () => {
  vi.useFakeTimers();
  const cache = createRevisionCache(10);
  await cache.page(1);
  vi.advanceTimersByTime(60_001);
  let resolve!: (value: { commits: typeof commits }) => void;
  getHistory.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const refresh = cache.page(1);
  expect(cache.peekPage(1)).toBe(commits);
  expect(cache.page(1)).toBe(refresh);
  await Promise.resolve();
  resolve({ commits });
  await refresh;
  expect(getHistory).toHaveBeenCalledTimes(2);
});

it('invalidates shifted later pages when a refreshed list has a new head', async () => {
  vi.useFakeTimers();
  const cache = createRevisionCache(10);
  await cache.page(1);
  await cache.page(2);
  vi.advanceTimersByTime(60_001);
  getHistory.mockResolvedValueOnce({ commits: [{ commit: 'new' }] });
  await cache.page(1);
  expect(cache.peekPage(2)).toBeUndefined();
  await cache.page(2);
  expect(getHistory).toHaveBeenCalledTimes(4);
});

it('caches explicit missing revisions while preserving other errors for retry', async () => {
  const cache = createRevisionCache(10);
  getVersion.mockRejectedValueOnce(
    new Error('API HTTP 404: {"error":"Tooltip did not exist at that commit"}'),
  );
  await expect(cache.version('deleted')).resolves.toBeNull();
  await expect(cache.version('deleted')).resolves.toBeNull();
  expect(getVersion).toHaveBeenCalledTimes(1);
  for (const message of [
    'API HTTP 404: {"error":"Endpoint not found"}',
    'API HTTP 403: Forbidden',
    'API HTTP 502: Upstream failed',
    'API HTTP 404: invalid JSON',
  ]) {
    const retryCache = createRevisionCache(10);
    getVersion.mockRejectedValueOnce(new Error(message));
    await expect(retryCache.version('retry')).rejects.toThrow(message);
    await expect(retryCache.version('retry')).resolves.toEqual({ commit: 'retry' });
  }
});

it('cancels pending page and revision loads without discarding completed cache entries', async () => {
  const cache = createRevisionCache(10);
  await cache.page(2);
  await cache.version('kept');
  const abortable = (_hash: number, _key: unknown, signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  getHistory.mockImplementationOnce(abortable);
  getVersion.mockImplementationOnce(abortable);
  const page = cache.page(1),
    version = cache.version('pending');
  await Promise.resolve();
  const pageSignal = getHistory.mock.calls.at(-1)![2] as AbortSignal;
  const versionSignal = getVersion.mock.calls.at(-1)![2] as AbortSignal;
  cache.cancelPending();
  expect(pageSignal.aborted).toBe(true);
  expect(versionSignal.aborted).toBe(true);
  await expect(page).rejects.toMatchObject({ name: 'AbortError' });
  await expect(version).rejects.toMatchObject({ name: 'AbortError' });
  expect(cache.peekPage(2)).toBe(commits);
  await cache.version('kept');
  expect(getVersion).toHaveBeenCalledTimes(2);
  await cache.page(1);
  await cache.version('pending');
  expect(getHistory).toHaveBeenCalledTimes(3);
  expect(getVersion).toHaveBeenCalledTimes(3);
});

it('uses the per-tooltip trailer without requesting either body', async () => {
  const cache = createRevisionCache(10);
  const entries = [
    { commit: 'hint', message: 'Clarity-Changed: 10=en,associations;20=de' },
  ] as never;
  await expect(cache.classify(entries, 0, 1, false)).resolves.toEqual({
    languages: ['en'],
    fields: ['associated'],
  });
  expect(getVersion).not.toHaveBeenCalled();
});

it('caps body requests at four, aborts queued work, and permits retry', async () => {
  const cache = createRevisionCache(10);
  getVersion.mockImplementation(
    (_hash: number, _key: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  const requests = Array.from({ length: 12 }, (_, index) => cache.version(String(index)));
  const settled = Promise.allSettled(requests);
  await Promise.resolve();
  expect(getVersion).toHaveBeenCalledTimes(4);
  cache.cancelPending();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  expect(getVersion).toHaveBeenCalledTimes(4);
  getVersion.mockResolvedValue({ tooltip: null });
  await expect(cache.version('0')).resolves.toBeNull();
});
