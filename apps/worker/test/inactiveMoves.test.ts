import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { inactiveMovesPath } from '@clarity/core';
import { blobOid, Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const get = (user = 1) => fixture.request('/inactive-moves', 'GET', undefined, user);
const put = (inactive = true, revision: string | null = null, user = 1) =>
  fixture.request('/inactive-moves', 'PUT', { hash: 123, inactive, revision }, user);

it('refuses editors, translators, trials, and unknown accounts before body validation', async () => {
  for (const user of [2, 3, 4, 99]) {
    expect((await get(user)).status).toBe(403);
    expect((await put(true, null, user)).status).toBe(403);
    expect((await fixture.request('/inactive-moves', 'PUT', {}, user)).status).toBe(403);
  }
  expect(fixture.commits).toHaveLength(0);
});

it('moves in and out, returns reloadable CAS revisions, and attributes the maintainer', async () => {
  expect(await (await get()).json()).toEqual({ revision: null, moves: {} });
  const first = await put();
  expect(first.status).toBe(200);
  const saved = await first.json();
  expect(saved.moves).toEqual({ 123: { by: 1, at: expect.any(String) } });
  expect(saved.revision).toBe(blobOid(saved.moves));
  expect(fixture.commits[0]).toMatchObject({
    author: { name: 'alice', email: '1+alice@users.noreply.github.com' },
  });
  expect(await (await get()).json()).toMatchObject({
    revision: saved.revision,
    moves: saved.moves,
  });
  const removed = await put(false, saved.revision);
  expect(removed.status).toBe(200);
  expect((await removed.json()).moves).toEqual({});
  expect(fixture.current()[inactiveMovesPath]).toEqual({});
});

it('rejects stale revisions, including concurrent moves during the commit', async () => {
  const saved = await (await put()).json();
  expect((await put(false)).status).toBe(409);
  fixture.beforePatch = () => fixture.moveData({ [inactiveMovesPath]: {} });
  expect((await put(false, saved.revision)).status).toBe(409);
});

it('rechecks role on retry, and preserves concurrent unrelated edits', async () => {
  fixture.beforePatch = () => fixture.moveData({ 'unrelated.json': {} });
  expect((await put()).status).toBe(200);
  expect(fixture.current()['unrelated.json']).toEqual({});
  const saved = await (await get()).json();
  fixture.beforePatch = () =>
    fixture.moveData({
      'config/permissions.json': { users: { 1: { login: 'alice', role: 'editor' } } },
    });
  expect((await put(false, saved.revision)).status).toBe(403);
  expect(fixture.current()[inactiveMovesPath]).toEqual(saved.moves);
});

it('fails closed on malformed storage, and rejects invalid hashes and client attribution', async () => {
  for (const hash of [-1, 0x100000000, '123'])
    expect(
      (
        await fixture.request('/inactive-moves', 'PUT', {
          hash,
          inactive: true,
          revision: null,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await fixture.request('/inactive-moves', 'PUT', {
        hash: 123,
        inactive: true,
        revision: null,
        by: 2,
      })
    ).status,
  ).toBe(400);
  fixture.moveData({ [inactiveMovesPath]: { 123: { by: 1 } } });
  expect((await get()).status).toBe(502);
  expect((await put()).status).toBe(502);
});
