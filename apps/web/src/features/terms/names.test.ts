import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureNames, namesRetryMs, namesUrl, resetNamesForTests, useNamesStore } from './names';

const file = {
  v: 1,
  lang: 'de',
  manifestVersion: 'm1',
  names: { 1: 'Voltschuss' },
  itemNames: {},
  setNames: {},
};
const settle = () =>
  vi.waitFor(() => expect(useNamesStore.getState().byLang.de?.status).not.toBe('loading'));

describe('ensureNames', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetNamesForTests();
  });

  it('loads a language once per session', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(file)));
    vi.stubGlobal('fetch', fetch);
    ensureNames('de');
    ensureNames('de');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(namesUrl('de'), undefined);
    expect(useNamesStore.getState().byLang.de).toEqual({ status: 'ready', file });
  });

  it('never loads English', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    ensureNames('en');
    expect(fetch).not.toHaveBeenCalled();
    expect(useNamesStore.getState().byLang.en).toBeUndefined();
  });

  it('reports a missing names file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    ensureNames('de');
    await settle();
    expect(useNamesStore.getState().byLang.de).toEqual({ status: 'missing' });
  });

  it('reports an offline failure and retries after a pause', async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetch);
    ensureNames('de');
    await settle();
    expect(useNamesStore.getState().byLang.de?.status).toBe('error');
    fetch.mockImplementation(async () => new Response(JSON.stringify(file)));
    // Stepping to the next tooltip right away does not request again.
    ensureNames('de');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + namesRetryMs);
    ensureNames('de');
    await vi.waitFor(() => expect(useNamesStore.getState().byLang.de?.status).toBe('ready'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a file for another language', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...file, lang: 'fr' }))),
    );
    ensureNames('de');
    await settle();
    expect(useNamesStore.getState().byLang.de?.status).toBe('error');
  });
});
