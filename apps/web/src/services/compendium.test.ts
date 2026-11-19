import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('./http', () => ({ fetchJson }));
vi.mock('./api', () => ({ apiRequest: vi.fn() }));

const data = (fetchedAt: string) => ({ fetchedAt, tabs: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe('loadCompendium', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchJson.mockReset();
  });

  it('joins an in-flight request for ordinary loads', async () => {
    const first = deferred<unknown>();
    fetchJson.mockReturnValueOnce(first.promise);
    const { loadCompendium } = await import('./compendium');
    const a = loadCompendium();
    const b = loadCompendium();
    first.resolve(data('one'));
    await Promise.all([a, b]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('never lets a forced reload reuse an older in-flight request', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { loadCompendium } = await import('./compendium');
    const stale = loadCompendium();
    const fresh = loadCompendium(true);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    newer.resolve(data('after refresh'));
    expect((await fresh).fetchedAt).toBe('after refresh');
    // The older response lands late: it must not replace the newer cache.
    older.resolve(data('before refresh'));
    expect((await stale).fetchedAt).toBe('before refresh');
    expect((await loadCompendium()).fetchedAt).toBe('after refresh');
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
});

describe('Compendium refresh errors', () => {
  it('reads as a plain message, with the raw body kept as the cause', async () => {
    const { apiRequest } = await import('./api');
    const { requestCompendiumRefresh, compendiumRefreshStatus } = await import('./compendium');
    vi.mocked(apiRequest).mockResolvedValueOnce(
      Response.json({ error: 'Refresh already running' }, { status: 409 }),
    );
    await expect(requestCompendiumRefresh()).rejects.toThrow(
      new Error('Compendium refresh: Refresh already running'),
    );
    vi.mocked(apiRequest).mockResolvedValueOnce(new Response('<html>oops</html>', { status: 502 }));
    const failed = await compendiumRefreshStatus().catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(
      'Compendium refresh status failed (the server answered 502).',
    );
    expect((failed as Error).cause).toBe('<html>oops</html>');
  });
});
