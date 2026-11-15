import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createBatchFixture, type BatchFixture } from './fixtureWorker.testSupport';

const tooltip = (hash: number, en: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'a' } },
});

async function load() {
  vi.resetModules();
  return import('./api');
}

/** A batch holding tooltip 10 with new English, made through the fixture's own routes. */
async function seed(fixture: BatchFixture) {
  const created = await fixture.handle(
    new Request('https://worker.example/batches', {
      method: 'POST',
      body: JSON.stringify({ name: 'December patch' }),
    }),
  );
  const { batch } = (await created!.json()) as { batch: { id: string; revision: number } };
  const saved = await fixture.handle(
    new Request(`https://worker.example/batches/${batch.id}/save`, {
      method: 'POST',
      body: JSON.stringify({
        revision: batch.revision,
        changes: [{ hash: 10, base: tooltip(10, 'Old'), next: tooltip(10, 'New') }],
      }),
    }),
  );
  expect(saved!.status).toBe(200);
  return batch.id;
}

describe('scheduled batches client', () => {
  let fixture: BatchFixture;
  let calls: string[];
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
    for (const name of ['localStorage', 'sessionStorage'])
      vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
    fixture = createBatchFixture({
      current: { 10: tooltip(10, 'Old') },
      user: { id: 1, login: 'm', role: 'maintainer' },
    });
    calls = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init).url);
      return fixture.fetch(input, init);
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('makes no request with the build switch OFF', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
    const api = await load();
    await expect(api.listBatches()).rejects.toThrow('Scheduled changes are off');
    await expect(api.readBatchMembers('a'.repeat(40), 'x', [10])).rejects.toThrow(
      'Scheduled changes are off',
    );
    expect(calls).toEqual([]);
  });

  it('lists batches and reads members at the listed head, cached per head', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const api = await load();
    const id = await seed(fixture);
    const { head, index } = await api.listBatches();
    expect(head).toBe(fixture.head);
    expect(index.batches).toMatchObject([{ id, name: 'December patch', hashes: [10] }]);
    calls.length = 0;
    const [member, absent] = await api.readBatchMembers(head, id, [10, 11]);
    expect(member?.proposed.text.en?.text).toBe('New');
    // No file for 11 at this head: null, not an error.
    expect(absent).toBeNull();
    expect(calls).toEqual([
      `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/${head}/schedule/batches/${id}/tooltips/10.json`,
      `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/${head}/schedule/batches/${id}/tooltips/11.json`,
    ]);
    // Same head: served from the cache.
    calls.length = 0;
    expect((await api.readBatchMembers(head, id, [10]))[0]).toEqual(member);
    expect(calls).toEqual([]);
  });

  it('refuses invalid or misplaced member files and does not cache the failure', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    const api = await load();
    const head = 'b'.repeat(40);
    let body: unknown = { hash: 10 };
    api.setRawFetch(async () => new Response(JSON.stringify(body)));
    await expect(api.readBatchMembers(head, 'x', [10])).rejects.toThrow();
    // A valid member stored under another hash's path.
    body = {
      hash: 12,
      base: null,
      baseCommit: head,
      proposed: tooltip(12, 'Twelve'),
      updatedAt: '2026-11-13T12:00:00.000Z',
      updatedBy: 'm',
    };
    await expect(api.readBatchMembers(head, 'x', [10])).rejects.toThrow('holds tooltip 12');
    // The next read tries again and succeeds.
    body = { ...(body as object), hash: 10, proposed: tooltip(10, 'Ten') };
    const [member] = await api.readBatchMembers(head, 'x', [10]);
    expect(member?.proposed.text.en?.text).toBe('Ten');
    api.setRawFetch(async () => new Response('nope', { status: 500 }));
    await expect(api.readBatchMembers('c'.repeat(40), 'x', [10])).rejects.toThrow('HTTP 500');
    await expect(api.readBatchMembers('not a sha', 'x', [10])).rejects.toThrow();
  });
});
