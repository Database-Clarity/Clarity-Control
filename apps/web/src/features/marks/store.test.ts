import { afterEach, expect, it, vi } from 'vitest';
import { type Marks } from '@clarity/core/marks';

vi.mock('../../services/api', () => ({ apiRequest: vi.fn(), apiUrl: 'https://api.test' }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});
const marks: Marks = {
  types: [{ id: 'test', label: 'Testing', colour: 'blue', by: 1, at: '2026-11-15T00:00:00Z' }],
  entries: {},
};

it('fetches marks once with no-store, and treats only 404 as an empty file', async () => {
  const { useMarksStore, marksUrl } = await import('./store');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  await Promise.all([useMarksStore.getState().load(), useMarksStore.getState().load()]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]).toEqual([
    expect.stringContaining(marksUrl + '?at='),
    { cache: 'no-store' },
  ]);
  expect(useMarksStore.getState()).toMatchObject({
    marks: { types: [], entries: {} },
    writable: false,
    error: null,
  });
});
it.each([Response.json({}), new Response('', { status: 502 })])(
  'keeps the catalogue usable and marks read-only on a bad response',
  async (response) => {
    const { useMarksStore } = await import('./store');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response.clone()),
    );
    await useMarksStore.getState().load();
    expect(useMarksStore.getState().error).toContain('read-only');
    expect(useMarksStore.getState().writable).toBe(false);
  },
);
it('does not replace newer authenticated marks with a late public response', async () => {
  const { useMarksStore } = await import('./store');
  const { apiRequest } = await import('../../services/api');
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const loading = useMarksStore.getState().load();
  vi.mocked(apiRequest).mockResolvedValue(Response.json({ marks, revision: 'a'.repeat(40) }));
  await useMarksStore.getState().reload();
  resolve(Response.json({ types: [], entries: {} }));
  await loading;
  expect(useMarksStore.getState()).toMatchObject({ marks, writable: true });
});
it('ignores authenticated results after sign-out', async () => {
  const { useMarksStore } = await import('./store');
  const { useAuthStore } = await import('../../stores/auth');
  const { apiRequest } = await import('../../services/api');
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' }, token: 'a' });
  let resolve!: (response: Response) => void;
  vi.mocked(apiRequest).mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const loading = useMarksStore.getState().reload();
  useAuthStore.setState({ user: null, token: null });
  resolve(Response.json({ marks, revision: 'a'.repeat(40) }));
  await loading;
  expect(useMarksStore.getState().writable).toBe(false);
  expect(useMarksStore.getState().marks.types).toEqual([]);
});
