import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import { loadPublished, publishedFor, resetPublished, usePublished } from './published';

vi.mock('../../services/history', () => ({ getPushedVersion: vi.fn() }));

const live = (hash: number, text = 'Live'): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
});
const state = (hash: number, marker: string) =>
  publishedFor(usePublished.getState().byHash, hash, marker);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  resetPublished();
  vi.mocked(getPushedVersion).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('asks once per hash and marker, at most four at a time, and never for new rows', async () => {
  const pending: ((value: { pushedHash: string; tooltip: Tooltip }) => void)[] = [];
  vi.mocked(getPushedVersion).mockImplementation(
    (hash) =>
      new Promise((resolve) =>
        pending.push(() => resolve({ pushedHash: 'm', tooltip: live(hash) })),
      ),
  );
  const rows = [1, 2, 3, 4, 5, 6].map((hash) => ({ hash, marker: 'm' }));
  await loadPublished([...rows, { hash: 7, marker: undefined }]);
  expect(getPushedVersion).toHaveBeenCalledTimes(4);
  expect(publishedFor(usePublished.getState().byHash, 7, undefined)).toEqual({
    status: 'ready',
    tooltip: null,
  });
  await loadPublished(rows);
  expect(getPushedVersion).toHaveBeenCalledTimes(4);
  pending[0]!({ pushedHash: 'm', tooltip: live(1) });
  await vi.waitFor(() => expect(getPushedVersion).toHaveBeenCalledTimes(5));
  for (const resolve of pending.slice(1)) resolve({ pushedHash: 'm', tooltip: live(0) });
  await vi.waitFor(() => expect(getPushedVersion).toHaveBeenCalledTimes(6));
  for (const resolve of pending) resolve({ pushedHash: 'm', tooltip: live(0) });
  await vi.waitFor(() => expect(state(6, 'm')).toMatchObject({ status: 'ready' }));
  // A newer marker for the same hash is a new question.
  expect(state(1, 'newer')).toBeUndefined();
});

it('reads a stored result on the next visit without a request', async () => {
  vi.mocked(getPushedVersion).mockResolvedValue({ pushedHash: 'm', tooltip: live(1) });
  await loadPublished([{ hash: 1, marker: 'm' }]);
  await vi.waitFor(() => expect(state(1, 'm')).toMatchObject({ status: 'ready' }));
  // The write is optional and asynchronous; give it its turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
  resetPublished();
  vi.mocked(getPushedVersion).mockClear();
  await loadPublished([{ hash: 1, marker: 'm' }]);
  await vi.waitFor(() =>
    expect(state(1, 'm')).toEqual({ status: 'ready', tooltip: live(1), marker: 'm' }),
  );
  expect(getPushedVersion).not.toHaveBeenCalled();
  // Another marker misses the stored copy.
  vi.mocked(getPushedVersion).mockResolvedValue({ pushedHash: 'n', tooltip: live(1, 'Newer') });
  await loadPublished([{ hash: 1, marker: 'n' }]);
  await vi.waitFor(() => expect(getPushedVersion).toHaveBeenCalledOnce());
});

it('tells a failed request (Retry) from an unrecoverable legacy marker', async () => {
  vi.mocked(getPushedVersion)
    .mockRejectedValueOnce(new Error('API HTTP 500: upstream'))
    .mockRejectedValueOnce(
      new Error('API HTTP 409: The pushed version could not be recovered from history.'),
    );
  await loadPublished([
    { hash: 1, marker: 'm' },
    { hash: 2, marker: 'm' },
  ]);
  await vi.waitFor(() => expect(state(2, 'm')).toMatchObject({ status: 'missing' }));
  expect(state(1, 'm')).toMatchObject({ status: 'error', error: 'API HTTP 500: upstream' });
  // Without retry nothing is asked again; Retry asks for the failed row only.
  vi.mocked(getPushedVersion).mockResolvedValue({ pushedHash: 'm', tooltip: live(1) });
  await loadPublished([
    { hash: 1, marker: 'm' },
    { hash: 2, marker: 'm' },
  ]);
  expect(getPushedVersion).toHaveBeenCalledTimes(2);
  await loadPublished(
    [
      { hash: 1, marker: 'm' },
      { hash: 2, marker: 'm' },
    ],
    true,
  );
  await vi.waitFor(() => expect(state(1, 'm')).toMatchObject({ status: 'ready' }));
  expect(getPushedVersion).toHaveBeenCalledTimes(3);
  expect(state(2, 'm')).toMatchObject({ status: 'missing' });
});

it('forgets failures when the account changes', async () => {
  vi.mocked(getPushedVersion).mockRejectedValue(new Error('API HTTP 401: sign in'));
  await loadPublished([{ hash: 1, marker: 'm' }]);
  await vi.waitFor(() => expect(state(1, 'm')).toMatchObject({ status: 'error' }));
  useAuthStore.setState({ user: { id: 9, login: 'next', role: 'editor' } });
  expect(state(1, 'm')).toBeUndefined();
  useAuthStore.setState({ user: null });
});
