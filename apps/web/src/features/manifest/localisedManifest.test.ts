import { indexedDB } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureNames, resetNamesForTests, useNamesStore } from '../terms/names';

afterEach(() => {
  resetNamesForTests();
  vi.unstubAllGlobals();
});

it('keeps descriptions through the real loader, device cache, and an offline restart', async () => {
  vi.stubGlobal('indexedDB', indexedDB);
  const file = {
    v: 1,
    lang: 'de',
    manifestVersion: 'm1',
    names: { 1: 'Voltschuss' },
    itemNames: {},
    setNames: {},
    descriptions: { 1: 'Deutscher Text' },
    sandboxPerks: { 11: ['Vorteil', 'Vorteiltext'] },
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify(file)));
  vi.stubGlobal('fetch', fetch);
  ensureNames('de');
  await vi.waitFor(() =>
    expect(useNamesStore.getState().byLang.de).toEqual({ status: 'ready', file }),
  );
  // Reading in a later transaction waits for the loader's cache write to commit.
  await vi.waitFor(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('clarity-terms-v1', 1);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const cached = await new Promise((resolve) => {
        const request = db.transaction('names').objectStore('names').get('de');
        request.onsuccess = () => resolve(request.result);
      });
      expect(cached).toEqual(file);
    } finally {
      db.close();
    }
  });
  resetNamesForTests();
  fetch.mockRejectedValue(new TypeError('offline'));
  ensureNames('de');
  ensureNames('de');
  await vi.waitFor(() =>
    expect(useNamesStore.getState().byLang.de).toEqual({ status: 'ready', file, stale: true }),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
