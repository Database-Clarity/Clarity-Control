import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import publisherConfig from '../../../config/publisher.json';
import worker from '../src/index.js';
const request = (path: string) =>
  worker.fetch(new Request(`https://cpu.invalid${path}`, { method: 'POST' }), {} as never, {
    waitUntil() {},
  });
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network');
    }),
  ),
);
afterEach(() => {
  publisherConfig.enabled = false;
  vi.unstubAllGlobals();
});
it('defaults OFF and blocks new writes even before auth', async () => {
  expect(publisherConfig.enabled).toBe(false);
  expect((await request('/publish')).status).toBe(503);
  expect((await request('/publish/kick')).status).toBe(503);
  expect((await request('/push-live')).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it('ON removes the legacy writer and authenticates new endpoints', async () => {
  publisherConfig.enabled = true;
  expect((await request('/push-live')).status).toBe(410);
  expect((await request('/publish')).status).toBe(401);
  expect((await request('/publish/kick')).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
