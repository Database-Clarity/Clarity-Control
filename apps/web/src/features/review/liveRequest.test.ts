import { beforeEach, expect, it, vi } from 'vitest';
import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import {
  preparedReviewLiveValue,
  stageReviewRedirectLiveRequest,
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

it('hands the on-open redirect request to the normalized route once, with its abort signal', async () => {
  vi.useFakeTimers();
  try {
    stageReviewRedirectLiveRequest(123);
    await Promise.resolve();
    const signal = vi.mocked(getPushedVersion).mock.calls[0][1]!;
    const navigation = new AbortController();
    startReviewLiveRequest(123, navigation.signal);
    await vi.runAllTimersAsync();
    const result = takeReviewLiveRequest(123);
    expect(result.controller.signal).toBe(signal);
    expect(getPushedVersion).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    navigation.abort();
    expect(signal.aborted).toBe(true);
    startReviewLiveRequest(123, new AbortController().signal);
    takeReviewLiveRequest(123);
    expect(getPushedVersion).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('expires an unclaimed redirect response before a later visit can reuse it', async () => {
  vi.useFakeTimers();
  try {
    stageReviewRedirectLiveRequest(123);
    const signal = vi.mocked(getPushedVersion).mock.calls[0][1]!;
    await vi.runAllTimersAsync();
    expect(signal.aborted).toBe(true);
    expect(preparedReviewLiveValue(123)).toBeUndefined();
    startReviewLiveRequest(123, new AbortController().signal);
    expect(getPushedVersion).toHaveBeenCalledTimes(2);
    expect(takeReviewLiveRequest(123).controller.signal).not.toBe(signal);
  } finally {
    vi.useRealTimers();
  }
});

it('discards a redirect handoff when the selected hash or account changes', () => {
  stageReviewRedirectLiveRequest(123);
  const first = vi.mocked(getPushedVersion).mock.calls.at(-1)![1]!;
  startReviewLiveRequest(456, new AbortController().signal);
  expect(first.aborted).toBe(true);
  expect(takeReviewLiveRequest(456).hash).toBe(456);
  stageReviewRedirectLiveRequest(123);
  const second = vi.mocked(getPushedVersion).mock.calls.at(-1)![1]!;
  useAuthStore.setState({ user: { id: 2, login: 'other', role: 'editor' } });
  startReviewLiveRequest(123, new AbortController().signal);
  expect(second.aborted).toBe(true);
  expect(takeReviewLiveRequest(123).user?.id).toBe(2);
});
