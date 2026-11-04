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
  expect(getHistory).toHaveBeenCalledWith(10, 2);
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
  resolve({ commits });
  await refresh;
  expect(getHistory).toHaveBeenCalledTimes(2);
});
