import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  inactiveMovesPath,
  inactiveRemovalHash,
  inactivePublishableHash,
  type Tooltip,
} from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { generateKeyPairSync } from 'node:crypto';
import { blobOid, Fixture, makePrivateKey } from './fixture.js';

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  fixture.moveData({
    '.publisher/PIN': {
      sourceSha: 'a'.repeat(40),
      capabilities: [
        'inactiveMoves',
        'sandboxPointers',
        'markupBraces',
        'elementTags',
        'prismaticTags',
      ],
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const get = (user = 1) => fixture.request('/inactive-moves', 'GET', undefined, user);
const put = (inactive = true, revision: string | null = null, user = 1) =>
  fixture.request('/inactive-moves', 'PUT', { hash: 123, inactive, revision }, user);

it('gates saves and signed publish admission on the installed capability', async () => {
  publisherConfig.enabled = true;
  const saved = await (await put()).json();
  fixture.moveData({ '.publisher/PIN': { capabilities: [] } });
  expect((await put(false, saved.revision)).status).toBe(409);
  const opId = '01K95H00000000000000000001';
  const time = [...opId.slice(0, 10)].reduce(
    (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
    0,
  );
  vi.useFakeTimers({ toFake: ['Date'], now: time });
  fixture.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const input = { opId, hashes: [123], expected: { 123: await inactiveRemovalHash(123) } };
  expect((await fixture.request('/publish', 'POST', input)).status).toBe(409);
  fixture.moveData({ '.publisher/PIN': { capabilities: ['inactiveMoves'] } });
  expect((await fixture.request('/publish', 'POST', input)).status).toBe(202);
});

it('legacy push removes only selected output rows, preserves saved text, and restores on publish', async () => {
  const enabled = publisherConfig.enabled;
  publisherConfig.enabled = false;
  try {
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    const original = fixture.current()['tooltips/123.json'];
    const moved = await (await put()).json();
    expect((fixture.live.perks as Record<string, unknown>)[123]).toBeDefined();
    expect(
      (
        await fixture.request('/push-live', 'POST', {
          hashes: [123],
          expected: { 123: await inactiveRemovalHash(123) },
        })
      ).status,
    ).toBe(200);
    expect((fixture.live.perks as Record<string, unknown>)[123]).toBeUndefined();
    expect((fixture.live.perks as Record<string, unknown>)[789]).toBeUndefined();
    expect(fixture.current()['tooltips/123.json']).toEqual(original);
    const out = await (await put(false, moved.revision)).json();
    expect((fixture.live.perks as Record<string, unknown>)[123]).toBeUndefined();
    expect(
      (
        await fixture.request('/push-live', 'POST', {
          hashes: [123],
          expected: {
            123: await inactivePublishableHash(original as Tooltip, fixture.aliases, out.moves),
          },
        })
      ).status,
    ).toBe(200);
    expect((fixture.live.perks as Record<string, unknown>)[123]).toBeDefined();
  } finally {
    publisherConfig.enabled = enabled;
  }
});

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
  expect((await removed.json()).moves).toEqual({
    123: { inactive: false, by: 1, at: expect.any(String) },
  });
  expect(fixture.current()[inactiveMovesPath]).toEqual({
    123: { inactive: false, by: 1, at: expect.any(String) },
  });
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
