import { beforeEach, expect, it, vi } from 'vitest';
import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import {
  preparedReviewLiveValue,
  startReviewLiveRequest,
  takeReviewLiveRequest,
} from './liveRequest';

vi.mock('../../services/history', () => ({ getPushedVersion: vi.fn() }));
beforeEach(() => {
  vi.mocked(getPushedVersion).mockReset();
  vi.mocked(getPushedVersion).mockImplementation(async () => ({ tooltip: null, pushedHash: null }));
  takeReviewLiveRequest(-1).controller.abort();
  vi.mocked(getPushedVersion).mockClear();
  useAuthStore.setState({ user: { id: 1, login: 'editor', role: 'editor' } });
});

it('dedupes in-flight requests, and fetches fresh live data after completion', async () => {
  startReviewLiveRequest(123, new AbortController().signal);
  const first = takeReviewLiveRequest(123);
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
  expect(first.controller.signal.aborted).toBe(false);
  expect(takeReviewLiveRequest(123).pending).toBe(first.pending);
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
  await first.pending;
  startReviewLiveRequest(123, new AbortController().signal);
  takeReviewLiveRequest(123);
  expect(getPushedVersion).toHaveBeenCalledTimes(2);
});

it('does not reuse an abandoned route request', () => {
  const navigation = new AbortController();
  startReviewLiveRequest(123, navigation.signal);
  const previous = vi.mocked(getPushedVersion).mock.calls[0][1]!;
  navigation.abort();
  expect(previous.aborted).toBe(true);
  expect(takeReviewLiveRequest(123).controller.signal).not.toBe(previous);
});

it('makes a completed comparison available on first render, without reusing it on retry', async () => {
  const value = { tooltip: null, pushedHash: 'pushed' };
  vi.mocked(getPushedVersion).mockResolvedValue(value);
  startReviewLiveRequest(123, new AbortController().signal);
  await Promise.resolve();
  expect(preparedReviewLiveValue(123)).toBe(value);
  expect(preparedReviewLiveValue(456)).toBeUndefined();
  expect(takeReviewLiveRequest(123).value).toBe(value);
  expect(preparedReviewLiveValue(123)).toBeUndefined();
  expect(takeReviewLiveRequest(123).value).toBeUndefined();
});

it('does not reuse a response for another hash or account', () => {
  startReviewLiveRequest(123, new AbortController().signal);
  expect(takeReviewLiveRequest(456).hash).toBe(456);
  startReviewLiveRequest(123, new AbortController().signal);
  const previous = vi.mocked(getPushedVersion).mock.calls.at(-1)![1]!;
  useAuthStore.setState({ user: { id: 2, login: 'other', role: 'editor' } });
  expect(takeReviewLiveRequest(123).user?.id).toBe(2);
  expect(previous.aborted).toBe(true);
});

it('dedupes duplicate loader starts and retries a rejected request', async () => {
  const failure = new Error('offline');
  vi.mocked(getPushedVersion).mockRejectedValueOnce(failure);
  const first = startReviewLiveRequest(123, new AbortController().signal);
  expect(startReviewLiveRequest(123, new AbortController().signal)).toBe(first);
  expect(takeReviewLiveRequest(123).pending).toBe(first);
  await expect(first).rejects.toBe(failure);
  expect(takeReviewLiveRequest(123).pending).not.toBe(first);
  expect(getPushedVersion).toHaveBeenCalledTimes(2);
});

it('transfers an unprepared detail fetch through the loader before old cleanup', () => {
  const previous = takeReviewLiveRequest(123);
  startReviewLiveRequest(123, new AbortController().signal);
  previous.controller.abort();
  const next = takeReviewLiveRequest(123);
  expect(next.pending).toBe(previous.pending);
  expect(next.controller.signal.aborted).toBe(false);
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
  const transport = vi.mocked(getPushedVersion).mock.calls[0][1]!;
  expect(transport.aborted).toBe(false);
  next.controller.abort();
  expect(transport.aborted).toBe(true);
});
