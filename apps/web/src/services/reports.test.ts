import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('report client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    const storage = new Map<string, string>();
    for (const name of ['localStorage', 'sessionStorage'])
      vi.stubGlobal(name, {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('surfaces limits with the server wait, conflicts, and upload refusals as typed errors', async () => {
    const answers = [
      json({ error: 'Report limit reached', details: { key: 'ip10m', retry_after: 240 } }, 429),
      json({ error: 'Request id belongs to a different report' }, 409),
      json({ error: 'Screenshot is too large' }, 413),
      json({ error: 'Screenshot type does not match' }, 415),
      json({ error: 'Screenshots were removed from this report; uploads are closed' }, 409),
      new Response('<html>bad gateway</html>', { status: 502 }),
    ];
    const fetch = vi.fn(async () => answers.shift()!);
    vi.stubGlobal('fetch', fetch);
    const { submitReport, uploadScreenshot } = await import('./reportAccount');
    const { ReportApiError, waitText } = await import('./reports');
    const payload = {} as Parameters<typeof submitReport>[0];
    const limited = await submitReport(payload).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(ReportApiError);
    expect(limited).toMatchObject({ status: 429, retryAfter: 240, limitKey: 'ip10m' });
    expect(waitText(240)).toBe('4 min');
    expect(waitText(3900)).toBe('1 h 5 min');
    await expect(submitReport(payload)).rejects.toMatchObject({ status: 409 });
    const blob = new Blob(['x'], { type: 'image/webp' });
    await expect(uploadScreenshot('r-aaaaaaaa', 'id', blob)).rejects.toMatchObject({ status: 413 });
    await expect(uploadScreenshot('r-aaaaaaaa', 'id', blob)).rejects.toMatchObject({ status: 415 });
    await expect(uploadScreenshot('r-aaaaaaaa', 'id', blob)).rejects.toMatchObject({
      status: 409,
      message: 'Screenshots were removed from this report; uploads are closed',
    });
    await expect(submitReport(payload)).rejects.toMatchObject({
      status: 502,
      message: 'The server answered HTTP 502.',
    });
    const upload = fetch.mock.calls[2] as unknown as [string, RequestInit];
    expect(upload[0]).toBe('https://worker.example/reports/r-aaaaaaaa/files');
    expect(new Headers(upload[1].headers).get('X-Report-Request-Id')).toBe('id');
    expect(new Headers(upload[1].headers).get('Content-Type')).toBe('image/webp');
  });

  it('reports an unreachable server as status 0 and keeps the secret out of URLs', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ id: 'r-aaaaaaaa', status: 'withdrawn' }))
      .mockResolvedValueOnce(json([]));
    vi.stubGlobal('fetch', fetch);
    const { submitReport, withdrawReport } = await import('./reportAccount');
    const { publicAnchors } = await import('./reports');
    await expect(submitReport({} as Parameters<typeof submitReport>[0])).rejects.toMatchObject({
      status: 0,
    });
    await withdrawReport('r-aaaaaaaa', 'secret-value');
    const [url, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://worker.example/reports/r/r-aaaaaaaa/withdraw');
    expect(url).not.toContain('secret');
    expect(JSON.parse(String(init.body))).toEqual({ secret: 'secret-value' });
    await publicAnchors(124726501, 'en');
    const [publicUrl, publicInit] = fetch.mock.calls[2] as [string, RequestInit];
    expect(publicUrl).toBe('https://worker.example/reports/public?hash=124726501&lang=en');
    // Public reads never send the session (no preflight, no identity).
    expect(new Headers(publicInit.headers).has('Authorization')).toBe(false);
  });
});
