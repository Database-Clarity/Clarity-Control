import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('worker client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    const local = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    });
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('uses the configured login URL and credentials for /me', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 1,
          login: 'StardustD2',
          role: 'maintainer',
          languages: [],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const api = await import('./api');
    expect(api.loginUrl()).toBe('https://worker.example/auth/login');
    const token = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })) + '.signature';
    api.setSession(token);
    expect((await api.getMe())?.login).toBe('StardustD2');
    expect(fetch).toHaveBeenCalledWith('https://worker.example/me', {
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    });
    api.clearSession();
    expect(sessionStorage.getItem('clarity-editor-session')).toBeNull();
  });
  it('reads a partner /me as no editing role and keeps its projects', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ id: 42, login: 'p', role: 'partner', languages: [], projects: ['dim'] }),
        )
        .mockResolvedValueOnce(Response.json({ id: 1, login: 'a', role: 'editor', languages: [] })),
    );
    const api = await import('./api');
    expect(await api.getMe()).toEqual({
      id: 42,
      login: 'p',
      role: null,
      languages: [],
      projects: ['dim'],
    });
    expect((await api.getMe())?.role).toBe('editor');
  });
  it('returns 409 conflicts as typed data without losing base/head/next', async () => {
    const tooltip = { hash: 10, text: {}, associated: [] };
    const conflicts = [
      { hash: 10, base: tooltip, head: tooltip, next: tooltip, fields: ['text.en'] },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ conflicts }), { status: 409 })),
    );
    const { save } = await import('./api');
    expect(await save([{ hash: 10, base: tooltip, next: tooltip }], 'test')).toEqual({
      kind: 'conflicts',
      conflicts,
    });
  });
  it.each([undefined, null, 'bad', 0, -1, 9e15, 1234.5, 1793491200000])(
    'reads a valid server save time and tolerates missing or malformed time: %s',
    async (savedAt) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(Response.json({ commit: 'abc', tooltips: [], savedAt })),
      );
      const { save } = await import('./api');
      const result = await save([], 'test');
      expect(result).toEqual({
        kind: 'saved',
        commit: 'abc',
        tooltips: [],
        ...(savedAt === 1793491200000 ? { savedAt } : {}),
      });
    },
  );
  it.each([
    ['Thu, 12 Nov 2026 10:00:00 GMT', Date.parse('2026-11-12T10:00:00Z')],
    [null, undefined],
    ['not a date', undefined],
    ['Thu, 01 Jan 1970 00:00:00 GMT', undefined],
  ])('dates field conflicts by the response Date header: %s', async (date, serverAt) => {
    const conflict = {
      hash: 123,
      base: null,
      head: null,
      next: { hash: 123, text: {}, associated: [] },
      fields: ['$exists'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ conflicts: [conflict] }), {
          status: 409,
          headers: date ? { Date: date } : {},
        }),
      ),
    );
    const { save } = await import('./api');
    expect(await save([], 'test')).toEqual({
      kind: 'conflicts',
      conflicts: [conflict],
      ...(serverAt === undefined ? {} : { serverAt }),
    });
  });
  it('uses the Date header only when the save body has no server time', async () => {
    const date = 'Thu, 12 Nov 2026 10:00:00 GMT';
    const headers = { Date: date, 'Content-Type': 'application/json' };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ commit: 'abc', tooltips: [], savedAt: 1793491200000 }), {
            headers,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ commit: 'abc', tooltips: [] }), { headers }),
        ),
    );
    const { save } = await import('./api');
    expect(await save([], 'test')).toMatchObject({ savedAt: 1793491200000 });
    expect(await save([], 'test')).toMatchObject({ savedAt: Date.parse(date) });
  });
  it('reports API errors and rejects malformed successes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const { save, getMe } = await import('./api');
    await expect(save([], 'test')).rejects.toThrow('403');
    await expect(getMe()).rejects.toThrow();
  });
  it('distinguishes exhausted ref races from field conflicts and validates successful saves', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Concurrent writes; retry' }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ commit: 'abc', tooltips: [] })));
    vi.stubGlobal('fetch', fetch);
    const { save } = await import('./api');
    expect(await save([], 'test')).toEqual({ kind: 'retry', error: 'Concurrent writes; retry' });
    expect(await save([], 'test')).toEqual({ kind: 'saved', commit: 'abc', tooltips: [] });
  });
  it('does not call an unconfigured API and treats 401 as logged out', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    let api = await import('./api');
    expect(await api.getMe()).toBeNull();
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', '');
    api = await import('./api');
    await expect(api.save([], 'test')).rejects.toThrow('read-only');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports settings sync failures in plain words, keeping the technical cause apart', async () => {
    const settings = {
      dateFormat: 'auto',
      timeDisplay: 'datetime',
      timeZone: 'auto',
      markupToolbar: 'closed',
      englishSource: 'changes',
    } as const;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'GitHub refused' }), { status: 503 }),
        ),
    );
    const api = await import('./api');
    expect(await api.putSettings(settings, null)).toEqual({
      kind: 'failed',
      error: 'the server is unavailable',
      detail: 'HTTP 503: GitHub refused',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await api.putSettings(settings, null)).toEqual({
      kind: 'failed',
      error: 'the connection failed (you may be offline)',
      detail: 'Failed to fetch',
    });
    expect(api.syncFailureText(401)).toBe('sign in again to sync');
    expect(api.syncFailureText(413)).toBe('the server did not accept these settings');
  });
});
