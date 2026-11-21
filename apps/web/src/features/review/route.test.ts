import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LoaderFunctionArgs } from 'react-router-dom';
import { initialReviewParams, reviewRoute } from './route';
import { preparedPending, type PendingTooltip } from './model';
import { getPushedVersion } from '../../services/history';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { resetPublished, usePublished } from './published';

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
  resetPublished();
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'editor' } });
  useDataStore.setState({ data: { bundle: { pushed: {} } } as unknown as EditorData });
  vi.mocked(preparedPending).mockReturnValue(entries);
  vi.mocked(getPushedVersion).mockResolvedValue({ tooltip: null, pushedHash: null });
});
afterEach(() => {
  useAuthStore.setState({ user: previousUser });
  useDataStore.setState({ data: previousData });
  vi.clearAllMocks();
});

const entries = [
  { name: 'Alpha', category: 'Armor', categoryId: 'armor', tooltip: { hash: 1 }, pushed: 'm1' },
  { name: 'Beta', category: 'Weapons', categoryId: 'weapon', tooltip: { hash: 2 }, isNew: true },
  { name: 'Gamma', category: 'Weapons', categoryId: 'weapon', tooltip: { hash: 3 }, pushed: 'm3' },
] as PendingTooltip[];
it('keeps the prepared selection in the same filtered URL without a second page render', () => {
  expect(initialReviewParams(new URLSearchParams(), entries).toString()).toBe('hash=1');
  expect(
    initialReviewParams(new URLSearchParams('query=weap&hash=1&other=kept'), entries).toString(),
  ).toBe('query=weap&hash=2&other=kept');
  expect(initialReviewParams(new URLSearchParams('query=ARMOR&hash=2'), entries).get('hash')).toBe(
    '1',
  );
  expect(initialReviewParams(new URLSearchParams('hash=2'), entries).get('hash')).toBe('2');
  expect(initialReviewParams(new URLSearchParams('query=none&hash=2'), entries).toString()).toBe(
    'query=none',
  );
  // A kind filter waits for the words: the named change stays, the page settles it.
  expect(initialReviewParams(new URLSearchParams('kind=New&hash=3'), entries).toString()).toBe(
    'kind=New&hash=3',
  );
});

function open(search = '?hash=1', signal?: AbortSignal) {
  return reviewRoute({
    request: new Request(`https://app.invalid/review${search}`, { signal }),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
}

it('canonicalizes the default selection before loading anything', async () => {
  const result = open('');
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).headers.get('Location')).toBe('/review?hash=1');
  expect(getPushedVersion).not.toHaveBeenCalled();
});

it('loads the published text of every published change once, never for new ones', async () => {
  expect(open()).toBeNull();
  await vi.waitFor(() => expect(getPushedVersion).toHaveBeenCalledTimes(2));
  expect(vi.mocked(getPushedVersion).mock.calls.map(([hash]) => hash)).toEqual([1, 3]);
  await vi.waitFor(() =>
    expect(usePublished.getState().byHash[3]).toMatchObject({ status: 'ready', marker: 'm3' }),
  );
  // Other rows, a filter, or a revisit: no second request for the same markers.
  expect(open('?hash=3')).toBeNull();
  expect(open('?hash=1&query=A')).toBeNull();
  await Promise.resolve();
  expect(getPushedVersion).toHaveBeenCalledTimes(2);
});

it('commits local routing without waiting for the published text', async () => {
  vi.mocked(getPushedVersion).mockImplementation(() => new Promise(() => {}));
  expect(open()).toBeNull();
  expect(usePublished.getState().byHash[1]).toMatchObject({ status: 'loading' });
});

it('loads nothing signed out or for the Batches view', () => {
  useAuthStore.setState({ user: null });
  expect(open()).toBeNull();
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'editor' } });
  expect(open('?hash=1&view=batches')).toBeNull();
  expect(open('?view=batches')).toBeNull();
  expect(open('?view=batches&batch=example&query=weapon')).toBeNull();
  expect(getPushedVersion).not.toHaveBeenCalled();
});

it('opens on the changes people made, not the leftovers, unless the route names one', () => {
  const entry = (hash: number, markerOnly: boolean) =>
    ({
      tooltip: { hash },
      name: `E${hash}`,
      category: 'C',
      categoryId: 'c',
      markerOnly,
    }) as unknown as PendingTooltip;
  const mixed = [entry(1, true), entry(2, false), entry(3, true)];
  expect(initialReviewParams(new URLSearchParams(), mixed).get('hash')).toBe('2');
  expect(initialReviewParams(new URLSearchParams('hash=3'), mixed).get('hash')).toBe('3');
  expect(initialReviewParams(new URLSearchParams(), [entry(1, true)]).has('hash')).toBe(false);
});
