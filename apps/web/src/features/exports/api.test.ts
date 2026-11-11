// Save outcomes of the /exports client: 409 -> conflict (reload, keep edits), 429 -> cooldown with
// the Worker's retryAfter, 400/403 -> refused with the Worker's message; a saved config is
// validated again before the page uses it.
import { newStyleFile } from '@clarity/export';
import type { ExportConfig } from '@clarity/export/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  apiRequest: (path: string, init: RequestInit) => globalThis.fetch(path, init),
}));
const { saveProject, loadProject } = await import('./api');

const config: ExportConfig = {
  schema: 1,
  id: 'sample',
  name: 'Sample',
  files: [{ ...newStyleFile('descriptions', 'plain'), uid: 'u000000000000001' }],
};
const revision = 'a'.repeat(40);
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('saveProject', () => {
  it('maps 409, 429, and refusals', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'The project changed since it was loaded' }));
    expect(await saveProject('sample', revision, config)).toEqual({
      kind: 'conflict',
      message: 'The project changed since it was loaded',
    });
    vi.stubGlobal(
      'fetch',
      reply(429, { error: 'Saved moments ago; save again in 12 s', details: { retryAfter: 12 } }),
    );
    expect(await saveProject('sample', revision, config)).toEqual({
      kind: 'cooldown',
      message: 'Saved moments ago; save again in 12 s',
      retryAfter: 12,
    });
    vi.stubGlobal('fetch', reply(403, { error: 'Partners may only change files' }));
    expect(await saveProject('sample', revision, config)).toMatchObject({
      kind: 'refused',
      message: 'Partners may only change files',
    });
  });

  it('returns the saved config, validated, and sends revision + config', async () => {
    const fetch = reply(200, { commit: 'c'.repeat(40), revision: 'b'.repeat(40), config });
    vi.stubGlobal('fetch', fetch);
    expect(await saveProject('sample', revision, config)).toEqual({
      kind: 'saved',
      revision: 'b'.repeat(40),
      config,
      commit: 'c'.repeat(40),
    });
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/exports/projects/sample');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ revision, config });
  });

  it('refuses a stored config with unknown keys', async () => {
    vi.stubGlobal(
      'fetch',
      reply(200, { head: 'h', id: 'sample', revision, config: { ...config, extra: 1 } }),
    );
    await expect(loadProject('sample')).rejects.toThrow();
  });
});
