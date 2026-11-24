import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  globalsInPlaceCapability,
  globalsInPlacePath,
  globalsInPlacePublishContract,
  publishableHash,
} from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';
import { refuseInPlaceSave } from '../src/globals/inPlace.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: true } }));
let key: string;
const opId = '01K95H00000000000000000001';
const now = [...opId.slice(0, 10)].reduce(
  (value, character) => value * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(character),
  0,
);
beforeAll(async () => {
  key = await makePrivateKey();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'], now });
  const f = new Fixture(key);
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const value = {
    opId,
    hashes: [123],
    expected: { 123: await publishableHash(tooltip(), f.aliases) },
  };
  return { f, value };
}

it('admits shared definitions only with the active fence and a capable publisher', async () => {
  const { f, value } = await fixture();
  const route = `/publish?contract=${globalsInPlacePublishContract}`;
  const selected = {
    ...value,
    hashes: [],
    expected: {},
    globals: [{ id: 'g_fixture2000', expected: 'a'.repeat(64) }],
  };
  const fence = {
    destination: f.env.LIVE_BRANCH,
    legacyData: 'a'.repeat(40),
    legacyLive: 'b'.repeat(40),
    migratedLive: 'c'.repeat(40),
  };
  expect((await f.request(route, 'POST', selected, 2)).status).toBe(409);
  f.moveData({ [globalsInPlacePath]: { ...fence, state: 'hold' } });
  expect((await f.request(route, 'POST', selected, 2)).status).toBe(409);
  f.moveData({
    [globalsInPlacePath]: { ...fence, state: 'active' },
    '.publisher/PIN': { capabilities: [] },
  });
  expect((await f.request(route, 'POST', selected, 2)).status).toBe(409);
  f.moveData({ '.publisher/PIN': { capabilities: [globalsInPlaceCapability] } });
  expect(
    (await f.request(route, 'POST', { ...value, hashes: [2], expected: { 2: 'a'.repeat(64) } }, 2))
      .status,
  ).toBe(422);
  const stale = await f.request('/publish', 'POST', value, 2);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: expect.stringContaining('Reload this page') });
  expect(f.current()[`publish/requests/${opId}.json`]).toBeUndefined();
  const mixed = { ...value, globals: selected.globals };
  expect((await f.request(route, 'POST', mixed, 2)).status).toBe(202);
  expect((await f.request('/publish', 'POST', value, 2)).status).toBe(409);
  expect(f.current()[`publish/requests/${opId}.json`]).toBeDefined();
});

it('allows a named global import in an authored save and refuses a raw library root', () => {
  const document = tooltip();
  document.text.en!.text = 'import Barrier from global';
  expect(() => refuseInPlaceSave(document)).not.toThrow();
  document.text.en!.text = 'import main from 2';
  expect(() => refuseInPlaceSave(document)).toThrow('Use a shared export by name');
});
it.each([
  'globals/sync.json',
  'globals/layout.json',
  'globals/entries/g_partial000.json',
  'globals/live/converter-v2-test.json',
])('fails closed on %s before the migration', async (path) => {
  const { f, value } = await fixture();
  f.moveData({ [path]: {} });
  expect((await f.request('/publish', 'POST', value, 2)).status).toBe(409);
  expect(f.current()[`publish/requests/${opId}.json`]).toBeUndefined();
});
