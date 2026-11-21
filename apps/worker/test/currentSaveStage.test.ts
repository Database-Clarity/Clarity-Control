import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  currentSaveIntent,
  currentSavePartBytes,
  currentSaveStagePaths as paths,
  currentSaveStageRecord,
  currentSaveStagingCapability,
  type CurrentSaveStageRecord,
} from '@clarity/core';
import { newUlid } from '../src/schedule/store.js';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

const keys = generateKeyPairSync('ed25519');
const route = '/save/stage';
const content = Buffer.alloc(currentSavePartBytes, 32).toString('base64');
let appKey: string;
let f: Fixture;
let requestId: string;
beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(() => {
  f = new Fixture(appKey);
  requestId = newUlid();
  f.env.PUBLISH_SIGNING_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  f.moveData({ '.publisher/PIN': { capabilities: [currentSaveStagingCapability] } });
});
afterEach(() => vi.unstubAllGlobals());

it('stores bounded parts in sequence, and signs the immutable source only at finalization', async () => {
  const digest = 'a'.repeat(64);
  expect((await f.request(route, 'POST', { requestId, part: 1, content })).status).toBe(409);
  expect((await f.request(route, 'POST', { requestId, part: 0, content })).status).toBe(200);
  expect(f.current()[paths.part(requestId, 0)]).toBe(content);
  expect(f.current()[paths.kick(requestId)]).toBeUndefined();
  const sourceCommit = f.dataHead;
  expect((await f.request(route, 'POST', { requestId, parts: 2, digest })).status).toBe(409);
  expect((await f.request(route, 'POST', { requestId, parts: 1, digest }, 2)).status).toBe(404);
  expect((await f.request(route, 'POST', { requestId, parts: 1, digest })).status).toBe(202);
  const record = currentSaveStageRecord.parse(f.current()[paths.record(requestId)]);
  if (record.status !== 'queued') throw new Error('Expected a queued save');
  const { payload, sig } = record.envelope;
  expect(verify(null, Buffer.from(payload), keys.publicKey, Buffer.from(sig, 'base64'))).toBe(true);
  expect(currentSaveIntent.parse(JSON.parse(payload))).toMatchObject({
    requestId,
    sourceCommit,
    digest,
    parts: 1,
  });
  expect(f.current()['tooltips/123.json']).toEqual(tooltip());
  expect(f.current()[paths.kick(requestId)]).toEqual({ requestId });
  expect((await f.request(route, 'POST', { requestId, part: 1, content })).status).toBe(409);
});

it('checks permissions, the publisher capability, and the exact decoded part bound', async () => {
  const upload = { requestId, part: 0, content };
  expect((await f.request(route, 'POST', upload, 50)).status).toBe(403);
  const tooLarge = Buffer.alloc(currentSavePartBytes + 1).toString('base64');
  expect((await f.request(route, 'POST', { ...upload, content: tooLarge })).status).toBe(400);
  f.moveData({ '.publisher/PIN': { capabilities: [] } });
  expect((await f.request(route, 'POST', upload)).status).toBe(422);
  expect(f.commits).toHaveLength(0);
});

it('returns an immutable acknowledgement only to the submitting account', async () => {
  const commit = f.dataHead;
  const record: CurrentSaveStageRecord = {
    requester: { id: 1, login: 'alice' },
    updatedAt: new Date().toISOString(),
    status: 'saved',
    commit,
    savedAt: Date.now(),
  };
  f.moveData({ [paths.record(requestId)]: record });
  const status = await f.request(`${route}?requestId=${requestId}`);
  expect(await status.json()).toEqual({ status: 'saved', commit, savedAt: record.savedAt });
  expect((await f.request(`${route}?requestId=${requestId}`, 'GET', undefined, 2)).status).toBe(
    404,
  );
});
