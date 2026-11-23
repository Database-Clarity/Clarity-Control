import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  currentSaveIntent,
  currentSaveMaxParts,
  currentSavePartBytes,
  currentSaveStagePaths as paths,
  currentSaveStageRecord,
  currentSaveStartsPerHour,
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('stores bounded parts in sequence, and signs the immutable source only at finalization', async () => {
  const digest = 'a'.repeat(64);
  expect((await f.request(route, 'POST', { requestId, part: 1, content })).status).toBe(409);
  expect((await f.request(route, 'POST', { requestId, part: 0, content })).status).toBe(200);
  expect(f.current()[paths.part(requestId, 0)]).toBe(content);
  expect(f.current()[paths.kick(requestId)]).toBeUndefined();
  const status = `${route}?requestId=${requestId}`;
  expect(await (await f.request(status, 'GET', undefined)).json()).toEqual({ status: 'uploading' });
  expect((await f.request(status, 'GET', undefined, 2)).status).toBe(404);
  const sourceCommit = f.dataHead;
  expect((await f.request(route, 'POST', { requestId, parts: 2, digest })).status).toBe(409);
  expect((await f.request(route, 'POST', { requestId, parts: 1, digest }, 2)).status).toBe(404);
  expect((await f.request(route, 'POST', { requestId, parts: 1, digest })).status).toBe(202);
  const queuedCommit = f.dataHead;
  expect((await f.request(route, 'POST', { requestId, parts: 1, digest })).status).toBe(409);
  expect(f.dataHead).toBe(queuedCommit);
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
  expect(f.current()[paths.usage(1)]).toMatchObject({ active: null, starts: [expect.any(Number)] });
  expect((await f.request(route, 'POST', { requestId, part: 1, content })).status).toBe(409);
});

it('replaces the active upload on the same account and keeps another account’s upload', async () => {
  const other = newUlid();
  const replacement = newUlid();
  expect((await f.request(route, 'POST', { requestId, part: 0, content })).status).toBe(200);
  expect((await f.request(route, 'POST', { requestId, part: 1, content })).status).toBe(200);
  expect((await f.request(route, 'POST', { requestId: other, part: 0, content }, 2)).status).toBe(
    200,
  );
  expect(
    (await f.request(route, 'POST', { requestId: replacement, part: 0, content })).status,
  ).toBe(200);
  expect(f.current()[paths.record(requestId)]).toBeUndefined();
  expect(f.current()[paths.part(requestId, 0)]).toBeUndefined();
  expect(f.current()[paths.part(requestId, 1)]).toBeUndefined();
  expect(f.current()[paths.part(other, 0)]).toEqual(content);
  expect(f.current()[paths.usage(1)]).toMatchObject({
    active: { requestId: replacement, parts: 1 },
  });
  expect((await f.request(route, 'POST', { requestId, part: 2, content })).status).toBe(409);
  expect(
    (await f.request(route, 'POST', { requestId, parts: 2, digest: 'a'.repeat(64) })).status,
  ).toBe(409);
});

it('accepts the last allowed part and logs both oversized upload and finalization refusals', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parts = currentSaveMaxParts - 1;
  f.moveData({
    [paths.record(requestId)]: {
      requester: { id: 1, login: 'alice' },
      status: 'uploading',
      parts,
      updatedAt: new Date().toISOString(),
    },
    [paths.usage(1)]: { starts: [Date.now()], active: { requestId, parts } },
  });
  expect((await f.request(route, 'POST', { requestId, part: parts, content })).status).toBe(200);
  const head = f.dataHead;
  for (const input of [
    { part: currentSaveMaxParts, content },
    { parts: currentSaveMaxParts + 1, digest: 'a'.repeat(64) },
  ]) {
    const response = await f.request(route, 'POST', { requestId, ...input });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/16 MiB.*drafts are kept/i),
    });
  }
  expect(f.dataHead).toBe(head);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith('Current save staging guard', {
    guard: 'part ceiling',
    requesterId: 1,
  });
});

it('counts only recent starts and keeps the active upload when a new start exceeds the budget', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const now = Date.now();
  const starts = [
    now - 3_700_000,
    ...Array<number>(currentSaveStartsPerHour - 1).fill(now - 1_000),
  ];
  f.moveData({ [paths.usage(1)]: { active: null, starts } });
  expect((await f.request(route, 'POST', { requestId, part: 0, content })).status).toBe(200);
  const head = f.dataHead;
  const response = await f.request(route, 'POST', { requestId: newUlid(), part: 0, content });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: expect.stringMatching(/30 starts per hour.*drafts are kept/i),
  });
  expect(f.dataHead).toBe(head);
  expect(f.current()[paths.part(requestId, 0)]).toBe(content);
  expect(warn).toHaveBeenCalledWith('Current save staging guard', {
    guard: 'starts per hour',
    requesterId: 1,
  });
  expect((await f.request(route, 'POST', { requestId, part: 1, content })).status).toBe(200);
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
