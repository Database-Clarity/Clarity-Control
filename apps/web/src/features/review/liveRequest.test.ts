import { beforeEach, expect, it, vi } from 'vitest';
import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import { startReviewLiveRequest, takeReviewLiveRequest } from './liveRequest';

vi.mock('../../services/history', () => ({ getPushedVersion: vi.fn() }));
beforeEach(() => {
  vi.mocked(getPushedVersion).mockReset();
  vi.mocked(getPushedVersion).mockImplementation(async () => ({ tooltip: null, pushedHash: null }));
  takeReviewLiveRequest(-1).controller.abort();
  vi.mocked(getPushedVersion).mockClear();
  useAuthStore.setState({ user: { id: 1, login: 'editor', role: 'editor' } });
});

it('hands off one request, and fetches fresh live data on revisits and retries', () => {
  startReviewLiveRequest(123, new AbortController().signal);
  const first = takeReviewLiveRequest(123);
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
  expect(first.controller.signal.aborted).toBe(false);
  takeReviewLiveRequest(123);
  expect(getPushedVersion).toHaveBeenCalledTimes(2);
  startReviewLiveRequest(123, new AbortController().signal);
  takeReviewLiveRequest(123);
  expect(getPushedVersion).toHaveBeenCalledTimes(3);
});

it('does not reuse an abandoned route request', () => {
  const navigation = new AbortController();
  startReviewLiveRequest(123, navigation.signal);
  const previous = vi.mocked(getPushedVersion).mock.calls[0][1]!;
  navigation.abort();
  expect(previous.aborted).toBe(true);
  expect(takeReviewLiveRequest(123).controller.signal).not.toBe(previous);
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
