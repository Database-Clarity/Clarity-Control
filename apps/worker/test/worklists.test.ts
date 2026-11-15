import type { SettingsDatabase, SettingsStatement } from '../src/settings.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Fixture, makePrivateKey } from './fixture.js';
import worker from '../src/index.js';
import {
  decryptWorklist,
  encryptWorklist,
  worklistsFileId,
  worklistsKey,
} from '../src/worklists.js';

let key: string;
let fixture: Fixture;
let db: DatabaseSync;
let beforeWrite: (() => Promise<void>) | undefined;
const migration = readFileSync(
  new URL('../migrations/settings/0002_user_worklists.sql', import.meta.url),
  'utf8',
);
const binding: SettingsDatabase = {
  prepare(sql) {
    let values: (string | number | null)[] = [];
    const statement: SettingsStatement = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...values) ?? null) as T | null;
      },
      async run() {
        const hook = beforeWrite;
        beforeWrite = undefined;
        await hook?.();
        return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } };
      },
    };
    return statement;
  },
};
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  db = new DatabaseSync(':memory:');
  db.exec(migration);
  fixture.env.SETTINGS_DB = binding;
  beforeWrite = undefined;
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

const id = 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97';
const mine = { name: 'Weekend', hashes: [11, 12] };
const path = `/worklists/${id}`;
async function put(value: unknown, revision: string | null, user = 1, listId = id) {
  return fixture.request(
    `/worklists/${listId}`,
    'PUT',
    {
      op:
        revision === null
          ? { type: 'create', ...(value as object) }
          : 'type' in (value as object)
            ? value
            : { type: 'rename', name: (value as { name: string }).name },
      revision,
    },
    user,
  );
}
async function synced(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as {
    worklist: { id: string; name: string; hashes: number[] } | null;
    revision: string | null;
  };
}
async function read(user = 1) {
  return synced(await fixture.request(path, 'GET', undefined, user));
}
it('encrypts and authenticates metadata and membership per account and list', async () => {
  const key = await worklistsKey(fixture.env.SESSION_SECRET);
  const account = await worklistsFileId(fixture.env.SESSION_SECRET, 1);
  const encrypted = await encryptWorklist(key, `${account}:${id}:items`, mine);
  expect(await decryptWorklist(key, `${account}:${id}:items`, encrypted.iv, encrypted.ct)).toEqual(
    mine,
  );
  await expect(
    decryptWorklist(key, `${account}:other:items`, encrypted.iv, encrypted.ct),
  ).rejects.toThrow('could not be read');
  await expect(
    decryptWorklist(key, `${account}:${id}:meta`, encrypted.iv, encrypted.ct),
  ).rejects.toThrow();
});
it('requires signed-in editing roles', async () => {
  for (const user of [1, 2, 3, 4]) expect((await put(mine, null, user)).status).toBe(200);
  expect((await put(mine, null, 5)).status).toBe(403);
  const response = await worker.fetch(
    new Request('https://api.example' + path, { headers: { Origin: fixture.env.SITE_ORIGIN } }),
    fixture.env,
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(401);
});
it('isolates accounts and returns metadata only in the index', async () => {
  expect(await read()).toEqual({ worklist: null, revision: null });
  const first = await synced(await put(mine, null));
  expect(await read()).toEqual(first);
  expect((await read(2)).worklist).toBeNull();
  const row = db.prepare('SELECT * FROM user_worklists').get()!;
  expect(String(row.account_id)).toMatch(/^[0-9a-f]{64}$/);
  expect(String(row.ct)).not.toContain('Weekend');
  expect(String(row.meta_ct)).not.toContain('Weekend');
  const response = await fixture.request('/worklists', 'GET');
  expect(await response.json()).toEqual({
    lists: [
      { id, name: 'Weekend', count: 2, updatedAt: expect.any(Number), revision: first.revision },
    ],
  });
  expect(fixture.commits).toHaveLength(0);
});
it.each([false, true])('CAS preserves concurrent writers (existing: %s)', async (existing) => {
  const revision = existing ? (await synced(await put(mine, null))).revision : null;
  let winner: Awaited<ReturnType<typeof synced>>;
  beforeWrite = async () => {
    winner = await synced(await put({ name: 'Other device', hashes: [13] }, revision));
  };
  const loser = await put({ name: 'Local', hashes: [14] }, revision);
  expect(loser.status).toBe(409);
  expect(await loser.json()).toMatchObject(winner!);
  expect(await read()).toEqual(winner!);
});
it('does not rewrite unchanged rows and deletes only a matching revision', async () => {
  const first = await synced(await put(mine, null));
  const row = db.prepare('SELECT * FROM user_worklists').get();
  expect(await synced(await put(mine, first.revision))).toEqual(first);
  expect(db.prepare('SELECT * FROM user_worklists').get()).toEqual(row);
  const second = await synced(await put({ type: 'add', hashes: [13] }, first.revision));
  const stale = await put({ type: 'delete' }, first.revision);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject(second);
  expect((await put({ type: 'delete' }, second.revision)).status).toBe(200);
  expect((await read()).worklist).toBeNull();
});
it('rejects invalid and oversized membership, accepts a maximum-size list', async () => {
  for (const value of [
    { name: '', hashes: [] },
    { name: 'X', hashes: [-1] },
    { name: 'X', hashes: [1, 1] },
    { name: 'X', hashes: Array.from({ length: 501 }, (_, i) => i) },
    { ...mine, userId: 2 },
  ])
    expect((await put(value, null)).status).toBe(400);
  const first = await synced(
    await put({ name: 'Maximum', hashes: Array.from({ length: 500 }, (_, i) => i) }, null),
  );
  expect(first.worklist!.hashes).toHaveLength(500);
});
it('enforces the 50-list cap atomically and permits editing existing lists at the cap', async () => {
  for (let index = 0; index < 50; index++)
    await synced(
      await put(mine, null, 1, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    );
  expect((await put(mine, null)).status).toBe(400);
  const target = '00000000-0000-4000-8000-000000000000';
  const first = await synced(await fixture.request(`/worklists/${target}`, 'GET'));
  expect((await put({ ...mine, name: 'Updated' }, first.revision, 1, target)).status).toBe(200);
  await synced(await put(mine, null, 2));
});
it('detects ciphertext swaps and revision tampering without exposing another account', async () => {
  await synced(await put(mine, null));
  db.prepare('UPDATE user_worklists SET revision=?').run('b'.repeat(32));
  expect((await fixture.request(path, 'GET')).status).toBe(503);
  expect((await fixture.request('/worklists', 'GET')).status).toBe(503);
  expect((await read(2)).worklist).toBeNull();
});

it('enforces the account cap when two devices create the fiftieth list concurrently', async () => {
  for (let index = 0; index < 49; index++)
    await synced(
      await put(mine, null, 1, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    );
  const winner = '00000000-0000-4000-8000-999999999999';
  beforeWrite = async () => {
    await synced(await put({ name: 'Winner', hashes: [99] }, null, 1, winner));
  };
  expect((await put(mine, null)).status).toBe(400);
  expect(db.prepare('SELECT count(*) AS n FROM user_worklists').get()!.n).toBe(50);
  expect((await fixture.request(`/worklists/${winner}`, 'GET')).status).toBe(200);
});

it('applies add, remove, and move to the server row and keeps repeats idempotent', async () => {
  let result = await synced(await put(mine, null));
  result = await synced(await put({ type: 'add', hashes: [12, 13] }, result.revision));
  expect(result.worklist!.hashes).toEqual([11, 12, 13]);
  const revision = result.revision;
  result = await synced(await put({ type: 'add', hashes: [12, 13] }, revision));
  expect(result.revision).toBe(revision);
  result = await synced(await put({ type: 'move', hash: 13, index: 0 }, result.revision));
  expect(result.worklist!.hashes).toEqual([13, 11, 12]);
  result = await synced(await put({ type: 'remove', hashes: [11, 99] }, result.revision));
  expect(result.worklist!.hashes).toEqual([13, 12]);
});
