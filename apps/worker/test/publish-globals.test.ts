import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { inactiveRemovalHash, publishableHash, type GlobalPublicationRead } from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';
import { GitHub } from '../src/github.js';
import { publish } from '../src/publish.js';

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
it.each([
  'globals/sync.json',
  'globals/layout.json',
  'globals/entries/g_partial000.json',
  'globals/live/converter-v2-test.json',
])('fails closed on %s with no installed S5 proof adapter', async (path) => {
  const { f, value } = await fixture();
  f.moveData({ [path]: {} });
  expect((await f.request('/publish', 'POST', value, 2)).status).toBe(409);
  expect(f.current()[`publish/requests/${opId}.json`]).toBeUndefined();
});
it('requires the capability and an exact current certificate for each selected consumer', async () => {
  const { f, value } = await fixture();
  f.moveData({ 'globals/sync.json': {}, '.publisher/PIN': { capabilities: ['globalsRelease'] } });
  const sources = {
    authored: 'a'.repeat(40),
    definitions: 'b'.repeat(40),
    projections: 'c'.repeat(40),
    config: 'd'.repeat(40),
    live: 'e'.repeat(40),
    upcoming: 'f'.repeat(40),
    aliases: '1'.repeat(40),
    generator: '2'.repeat(40),
    fallback: '3'.repeat(64),
    resolver: '4'.repeat(64),
  };
  const read: GlobalPublicationRead = async (_head, consumers) => ({
    sources,
    sync: { version: 1, status: 'current', causeIds: [], causeEntries: {}, lastFailure: null },
    certificates: consumers.map((consumer) => ({
      version: 1,
      complete: true,
      sources,
      consumer,
      causeIds: [],
      independent: true,
      approved: true,
    })),
  });
  const request = () =>
    new Request('https://api.example/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const stale: GlobalPublicationRead = async (head, consumers) => {
    const proof = await read(head, consumers);
    proof.sources = { ...sources, authored: '9'.repeat(40) };
    return proof;
  };
  await expect(
    publish(request(), new GitHub(f.env), { id: 2, login: 'bob' }, stale),
  ).rejects.toMatchObject({ status: 409 });
  expect((await publish(request(), new GitHub(f.env), { id: 2, login: 'bob' }, read)).status).toBe(
    202,
  );
});
it('admits an explicitly reviewed inactive removal without publishing a global body', async () => {
  const { f, value } = await fixture();
  f.moveData({
    'globals/sync.json': {},
    '.publisher/PIN': { capabilities: ['globalsRelease', 'inactiveMoves'] },
    'config/inactive.json': { 123: { by: 1, at: new Date(now).toISOString() } },
  });
  value.expected[123] = await inactiveRemovalHash(123);
  const oid = 'a'.repeat(40),
    digest = 'b'.repeat(64);
  const sources = {
    authored: oid,
    definitions: oid,
    projections: oid,
    config: oid,
    live: oid,
    upcoming: oid,
    aliases: oid,
    generator: oid,
    fallback: digest,
    resolver: digest,
  };
  const read: GlobalPublicationRead = async (_head, consumers) => {
    expect(consumers).toEqual([{ hash: 123, lang: 'en', destination: f.env.LIVE_BRANCH }]);
    return {
      sources,
      sync: { version: 1, status: 'current', causeIds: [], causeEntries: {}, lastFailure: null },
      certificates: consumers.map((consumer) => ({
        version: 1,
        complete: true,
        sources,
        consumer,
        causeIds: [],
        independent: true,
        approved: true,
      })),
    };
  };
  const request = new Request('https://api.example/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  expect((await publish(request, new GitHub(f.env), { id: 2, login: 'bob' }, read)).status).toBe(
    202,
  );
});
