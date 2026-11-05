import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LoaderFunctionArgs } from 'react-router-dom';
import { initialReviewParams, reviewRoute } from './route';
import { preparedPending, type PendingTooltip } from './model';
import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { preparedReviewLiveValue, takeReviewLiveRequest } from './liveRequest';

vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://fixture.invalid',
}));
vi.mock('../../services/history', () => ({ getPushedVersion: vi.fn() }));
vi.mock('./model', async (original) => ({
  ...(await original<typeof import('./model')>()),
  preparedPending: vi.fn(),
}));

let previousUser = useAuthStore.getState().user;
let previousData = useDataStore.getState().data;
beforeEach(() => {
  previousUser = useAuthStore.getState().user;
  previousData = useDataStore.getState().data;
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'editor' } });
  useDataStore.setState({ data: { bundle: { pushed: {} } } as unknown as EditorData });
  vi.mocked(preparedPending).mockReturnValue(entries);
  vi.mocked(getPushedVersion).mockResolvedValue({ tooltip: null, pushedHash: null });
});
afterEach(() => {
  vi.mocked(getPushedVersion).mockResolvedValue({ tooltip: null, pushedHash: null });
  takeReviewLiveRequest(-1).controller.abort();
  useAuthStore.setState({ user: previousUser });
  useDataStore.setState({ data: previousData });
  vi.clearAllMocks();
});

const entries = [
  { name: 'Alpha', category: 'Armor', categoryId: 'armor', tooltip: { hash: 1 } },
  { name: 'Beta', category: 'Weapons', categoryId: 'weapon', tooltip: { hash: 2 } },
] as PendingTooltip[];
it('keeps the prepared selection in the same filtered URL without a second page render', () => {
  expect(initialReviewParams(new URLSearchParams(), entries).toString()).toBe('hash=1');
  expect(
    initialReviewParams(
      new URLSearchParams('category=weapon&hash=1&other=kept'),
      entries,
    ).toString(),
  ).toBe('category=weapon&hash=2&other=kept');
  expect(initialReviewParams(new URLSearchParams('query=ARMOR&hash=2'), entries).get('hash')).toBe(
    '1',
  );
  expect(initialReviewParams(new URLSearchParams('hash=2'), entries).get('hash')).toBe('2');
  expect(initialReviewParams(new URLSearchParams('category=none&hash=2'), entries).toString()).toBe(
    'category=none',
  );
});

function open(signal?: AbortSignal, search = '?hash=1') {
  return reviewRoute({
    request: new Request(`https://app.invalid/review${search}`, { signal }),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
}

it('canonicalizes the default selection before requesting or mounting its detail', async () => {
  const result = await open(undefined, '');
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).headers.get('Location')).toBe('/review?hash=1');
  expect(getPushedVersion).not.toHaveBeenCalled();
  await expect(open()).resolves.toBeNull();
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
  expect(preparedReviewLiveValue(1)).toEqual({ tooltip: null, pushedHash: null });
});

it('keeps filtered or invalid selections on the canonical redirect path', async () => {
  const result = await open(undefined, '?category=weapon&hash=1');
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).headers.get('Location')).toBe('/review?category=weapon&hash=2');
  expect(getPushedVersion).not.toHaveBeenCalled();
});

it('keeps the canonical redirect for a trailing-slash URL', async () => {
  const result = await reviewRoute({
    request: new Request('https://app.invalid/review/'),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).headers.get('Location')).toBe('/review?hash=1');
  expect(getPushedVersion).not.toHaveBeenCalled();
});

it.each(['account', 'snapshot', 'canceled', 'other hash', 'filter', 'revisit'])(
  'requests a fresh comparison after %s changes',
  async (change) => {
    const controller = new AbortController();
    await open(controller.signal);
    if (change === 'account')
      useAuthStore.setState({ user: { id: 2, login: 'other', role: 'editor' } });
    if (change === 'snapshot')
      useDataStore.setState({ data: { ...useDataStore.getState().data! } });
    if (change === 'canceled') controller.abort();
    const search =
      change === 'other hash' ? '?hash=2' : change === 'filter' ? '?hash=1&query=A' : '?hash=1';
    await expect(open(undefined, search)).resolves.toBeNull();
    expect(getPushedVersion).toHaveBeenCalledTimes(2);
    expect(getPushedVersion).toHaveBeenLastCalledWith(
      change === 'other hash' ? 2 : 1,
      expect.any(AbortSignal),
    );
  },
);

it('finishes loading only when the selected live value is ready for the first render', async () => {
  let resolve!: (value: { tooltip: null; pushedHash: string }) => void;
  vi.mocked(getPushedVersion).mockImplementationOnce(
    () =>
      new Promise((ready) => {
        resolve = ready;
      }),
  );
  let finished = false;
  const navigation = open().then((value) => {
    finished = true;
    return value;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
  expect(preparedReviewLiveValue(1)).toBeUndefined();
  const value = { tooltip: null, pushedHash: 'published' };
  resolve(value);
  await expect(navigation).resolves.toBeNull();
  expect(preparedReviewLiveValue(1)).toBe(value);
  expect(takeReviewLiveRequest(1).value).toBe(value);
  expect(getPushedVersion).toHaveBeenCalledTimes(1);
});

it('leaves failed comparisons for the existing detail error and retry flow', async () => {
  vi.mocked(getPushedVersion).mockRejectedValueOnce(new Error('Offline'));
  await expect(open()).resolves.toBeNull();
  await expect(takeReviewLiveRequest(1).pending).rejects.toThrow('Offline');
  const retry = takeReviewLiveRequest(1);
  await expect(retry.pending).resolves.toEqual({ tooltip: null, pushedHash: null });
  expect(getPushedVersion).toHaveBeenCalledTimes(2);
});

it('aborts the selected request when its navigation is canceled', async () => {
  vi.mocked(getPushedVersion).mockImplementationOnce(
    (_hash, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
  const controller = new AbortController();
  const navigation = open(controller.signal);
  const signal = vi.mocked(getPushedVersion).mock.calls[0][1]!;
  controller.abort();
  await expect(navigation).resolves.toBeNull();
  expect(signal.aborted).toBe(true);
  expect(preparedReviewLiveValue(1)).toBeUndefined();
});
