import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GitHub } from '../src/github.js';
import { Fixture, makePrivateKey } from './fixture.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps error content out of request and push-marker console logs', async () => {
  const sentinel = 'PRIVATE_ERROR_CONTENT_SENTINEL';
  const fixture = new Fixture(await makePrivateKey());
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const errors = [
    new Error(sentinel),
    new z.ZodError([{ code: 'custom', path: [sentinel], message: sentinel }]),
  ];
  for (const error of errors) {
    const head = vi.spyOn(GitHub.prototype, 'head').mockRejectedValueOnce(error);
    expect((await fixture.request('/me')).status).toBe(502);
    head.mockRestore();
    expect(log.mock.calls.at(-1)).toEqual([
      'Worker request failed',
      error.constructor.name,
      ...(error instanceof z.ZodError ? [{ issueCount: 1, issueCodes: ['custom'] }] : []),
    ]);

    const commit = vi.spyOn(GitHub.prototype, 'commit').mockRejectedValueOnce(error);
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(502);
    commit.mockRestore();
    expect(log.mock.calls.at(-1)).toEqual([
      'Push marker failed after live write',
      error.constructor.name,
      ...(error instanceof z.ZodError ? [{ issueCount: 1, issueCodes: ['custom'] }] : []),
    ]);
  }
  expect(log).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
});
