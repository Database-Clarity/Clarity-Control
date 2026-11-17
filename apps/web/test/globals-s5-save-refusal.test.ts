import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Every web writer of tooltip drafts goes through these three calls (security review finding 5).
const change = (hash: number) => ({ hash, base: null, next: { hash } }) as never;
const batch = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:1/api');
  fetch = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('with globals on, save and both batch saves refuse hashes 2 and 3 before any request', async () => {
  vi.stubEnv('VITE_GLOBALS_ENABLED', '1');
  const api = await import('../src/services/api');
  const scheduled = await import('../src/services/scheduled/api');
  for (const hash of [2, 3]) {
    await expect(api.save([change(5), change(hash)], 'm')).rejects.toThrow(/saved per entry/);
    await expect(scheduled.saveToBatch(batch, 1, 'draft', [change(hash)], 'm')).rejects.toThrow(
      /saved per entry/,
    );
    expect(() => scheduled.queueBatchSave(batch, 1, [change(hash)], 'm')).toThrow(
      /saved per entry/,
    );
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('with globals off, a hash 2 save still reaches the Worker', async () => {
  const api = await import('../src/services/api');
  await api.save([change(2)], 'm').catch(() => undefined);
  expect(fetch).toHaveBeenCalledTimes(1);
});
