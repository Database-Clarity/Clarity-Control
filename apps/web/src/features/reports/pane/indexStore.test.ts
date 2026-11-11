import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => [] as { path: string; init?: RequestInit }[]);
const server = vi.hoisted(() => ({
  rev: '7',
  open: {} as Record<string, Record<string, number>>,
  fail: false,
}));
vi.mock('../../../services/api', async (original) => ({
  ...(await original<typeof import('../../../services/api')>()),
  apiUrl: 'https://api.test',
  apiRequest: async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    if (server.fail) return new Response('forbidden', { status: 403 });
    const etag = `"${server.rev}"`;
    if (new Headers(init?.headers).get('If-None-Match') === etag)
      return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(JSON.stringify({ v: 1, rev: server.rev, open: server.open }), {
      headers: { ETag: etag, 'Content-Type': 'application/json' },
    });
  },
}));

import { openCount, openPairs, reportLanguages, revalidateMs, useReportsIndex } from './indexStore';

beforeEach(() => {
  requests.length = 0;
  server.rev = '7';
  server.fail = false;
  server.open = { '124726501': { en: 2, de: 1 }, '42': { en: 1 } };
  useReportsIndex.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe('reports marker index', () => {
  it('loads once, answers counts from the map, and revalidates with the ETag (304)', async () => {
    const store = useReportsIndex.getState();
    await store.load('1:editor');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init?.cache).toBe('no-store');
    expect(new Headers(requests[0]!.init?.headers).get('If-None-Match')).toBeNull();
    const { open } = useReportsIndex.getState();
    expect(openCount(open, 124726501, 'en')).toBe(2);
    expect(openCount(open, 124726501, 'fr')).toBe(0);
    expect(openCount(null, 1, 'en')).toBeNull();
    // Within five minutes a focus costs nothing.
    await useReportsIndex.getState().load('1:editor');
    expect(requests).toHaveLength(1);
    // A forced revalidation sends the ETag; 304 keeps the very same map.
    await useReportsIndex.getState().load('1:editor', true);
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[1]!.init?.headers).get('If-None-Match')).toBe('"7"');
    expect(useReportsIndex.getState().open).toBe(open);
  });

  it('a deletion bumps the marker revision, so the next check replaces the counts', async () => {
    await useReportsIndex.getState().load('1:editor');
    // Delete the older of two reports: the count drops and the server's revision moves on.
    server.open = { '124726501': { en: 1, de: 1 } };
    server.rev = '8';
    await useReportsIndex.getState().load('1:editor', true);
    const { open, etag } = useReportsIndex.getState();
    expect(etag).toBe('"8"');
    expect(openCount(open, 124726501, 'en')).toBe(1);
    expect(openCount(open, 42, 'en')).toBe(0);
    // And the following check is a 304 that keeps the corrected counts.
    await useReportsIndex.getState().load('1:editor', true);
    expect(useReportsIndex.getState().open).toBe(open);
  });

  it('revalidates on a later focus only after five minutes', async () => {
    vi.useFakeTimers();
    await useReportsIndex.getState().load('1:editor');
    vi.advanceTimersByTime(revalidateMs - 1);
    await useReportsIndex.getState().load('1:editor');
    expect(requests).toHaveLength(1);
    vi.advanceTimersByTime(2);
    await useReportsIndex.getState().load('1:editor');
    expect(requests).toHaveLength(2);
  });

  it('starts over for another account; a failure leaves no markers', async () => {
    await useReportsIndex.getState().load('1:editor');
    server.open = {};
    await useReportsIndex.getState().load('2:translator');
    expect(new Headers(requests[1]!.init?.headers).get('If-None-Match')).toBeNull();
    expect(useReportsIndex.getState().open?.size).toBe(0);
  });

  it('a failed revalidation after a success drops the old counts and the ETag', async () => {
    await useReportsIndex.getState().load('1:editor');
    expect(useReportsIndex.getState().open?.size).toBe(2);
    server.fail = true;
    await useReportsIndex.getState().load('1:editor', true);
    expect(useReportsIndex.getState()).toMatchObject({ open: null, etag: undefined, failed: true });
    // Retry: a fresh request without the stale ETag restores the markers.
    server.fail = false;
    await useReportsIndex.getState().load('1:editor', true);
    expect(new Headers(requests.at(-1)!.init?.headers).get('If-None-Match')).toBeNull();
    expect(useReportsIndex.getState()).toMatchObject({ failed: false });
    expect(useReportsIndex.getState().open?.size).toBe(2);
  });

  it('translators see only their languages; others every language', () => {
    const open = new Map<number, Record<string, number>>([
      [124726501, { en: 2, de: 1 }],
      [42, { en: 1 }],
    ]);
    const translator = {
      id: 3,
      login: 't',
      role: 'translator' as const,
      languages: ['de' as const],
    };
    expect(openPairs(open, reportLanguages(translator))).toEqual([
      { hash: 124726501, lang: 'de', n: 1 },
    ]);
    expect(openPairs(open, reportLanguages({ id: 1, login: 'e', role: 'editor' }))).toHaveLength(3);
  });
});
