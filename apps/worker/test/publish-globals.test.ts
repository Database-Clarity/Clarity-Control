import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  inactiveRemovalHash,
  publicationSyncPendingCode,
  publishableHash,
  type GlobalPublicationRead,
} from '@clarity/core';
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
  f.moveData({
    'globals/sync.json': {},
    '.publisher/PIN': { capabilities: ['globalsRelease', 'globalsExportsV1'] },
  });
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
  ).rejects.toMatchObject({ status: 409, details: { code: publicationSyncPendingCode } });
  expect((await publish(request(), new GitHub(f.env), { id: 2, login: 'bob' }, read)).status).toBe(
    202,
  );
});
it('requires a current proof for a moved-inactive hash with no tooltip in a mixed publish', async () => {
  const { f, value } = await fixture();
  const moved = 3176795734;
  f.moveData({
    'globals/sync.json': {},
    '.publisher/PIN': { capabilities: ['globalsRelease', 'globalsExportsV1', 'inactiveMoves'] },
    'config/inactive.json': { [moved]: { by: 1, at: new Date(now).toISOString() } },
  });
  value.hashes.push(moved);
  const expected = { ...value.expected, [moved]: await inactiveRemovalHash(moved) };
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
    expect(consumers).toEqual(
      [123, moved].map((hash) => ({ hash, lang: 'en', destination: f.env.LIVE_BRANCH })),
    );
    return {
      sources,
      materializedSources: sources,
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
  const submit = (reader: GlobalPublicationRead) =>
    publish(
      new Request('https://api.example/publish', {
        method: 'POST',
        body: JSON.stringify({ ...value, expected }),
      }),
      new GitHub(f.env),
      { id: 2, login: 'bob' },
      reader,
    );
  const missing: GlobalPublicationRead = async (head, consumers) => {
    const proof = await read(head, consumers);
    proof.certificates[1] = null;
    return proof;
  };
  await expect(submit(missing)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining(String(moved)),
    details: { hashes: [moved] },
  });
  await expect(
    submit(async (head, consumers) => ({
      ...(await missing(head, consumers)),
      materializedSources: { ...sources, config: '9'.repeat(40) },
    })),
  ).rejects.toMatchObject({ status: 409, details: { code: publicationSyncPendingCode } });
  const pending = {
    version: 1,
    status: 'sync-pending',
    causeIds: ['cause'],
    causeEntries: { cause: 'g_fixture000' },
    lastFailure: null,
  };
  await expect(
    submit(async (head, consumers) => ({ ...(await missing(head, consumers)), sync: pending })),
  ).rejects.toMatchObject({ status: 409, details: { code: publicationSyncPendingCode } });
  await expect(
    submit(async (head, consumers) => ({
      ...(await missing(head, consumers)),
      sync: { ...pending, status: 'sync-failed', lastFailure: 'internal failure' },
    })),
  ).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('Global changes failed to sync'),
    details: { hashes: [123, moved] },
  });
  expect(f.current()[`publish/requests/${opId}.json`]).toBeUndefined();
  expect((await submit(read)).status).toBe(202);
});
