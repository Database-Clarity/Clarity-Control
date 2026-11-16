import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  batchSchema,
  canClaimPreparedBatch,
  matchesPreparationFence,
  nowMinute,
  scheduleBodyDigest,
  scheduleIntentPaths,
  schedulePreparationCapability,
  verifyScheduleRequest,
  type Batch,
  type ScheduleRequest,
} from '@clarity/core/schedule';
import publisherConfig from '../../../config/publisher.json';
import scheduledConfig from '../../../config/scheduled.json';
import { GitHub } from '../src/github.js';
import { switches } from '../src/schedule/store.js';
import { Fixture, config, makePrivateKey, tooltip } from './fixture.js';

const ID = '01K95H00000000000000000B01';
const RID = '01K95H00000000000000000A01';
const OTHER = '01K95H00000000000000000A02';
const path = `schedule/batches/${ID}/batch.json`;
const member = `schedule/batches/${ID}/tooltips/123.json`;
const oid = 'a'.repeat(40);
const alice = { id: 1, login: 'alice' };
const pin = { capabilities: ['scheduledBatches', schedulePreparationCapability] };
const keypair = generateKeyPairSync('ed25519');
let appKey: string;
let f: Fixture;
const storedBatch = () => batchSchema.parse(f.current()[path]);
const record = () => f.current()[scheduleIntentPaths.request(RID)] as ScheduleRequest;
const scheduleBody = () => ({
  requestId: RID,
  revision: 2,
  notBefore: nowMinute(Date.now() + 30 * 60_000),
  zone: 'Europe/Budapest',
});
const saveBody = () => ({
  requestId: RID,
  revision: 2,
  changes: [{ hash: 123, base: tooltip(), next: tooltip('updated') }],
  message: 'Stage changes',
});
async function call(action: string, value?: unknown, user = 1, method = 'POST') {
  const response = await f.request(`/batches/${ID}/${action}`, method, value, user);
  return {
    status: response.status,
    body: (await response.json()) as {
      batch: Batch;
      request: ScheduleRequest;
      message?: string;
      error?: string;
      savedAt?: number;
    },
  };
}
function scheduled() {
  const batch = {
    ...storedBatch(),
    status: 'scheduled' as const,
    opId: OTHER,
    notBefore: nowMinute(Date.now() + 30 * 60_000),
    zone: 'UTC',
    scheduledContentRevision: 1,
  };
  f.moveData({
    [path]: batch,
    [`publish/requests/${OTHER}.json`]: { payload: 'old signed approval', sig: 'old signature' },
    'schedule/due.json': {
      entries: [{ batchId: ID, opId: OTHER, notBefore: batch.notBefore, claimed: false }],
    },
  });
}
beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(() => {
  scheduledConfig.enabled = true;
  publisherConfig.enabled = true;
  vi.spyOn(switches, 'preparation').mockReturnValue(true);
  f = new Fixture(appKey);
  f.env.PUBLISH_SIGNING_KEY = keypair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const batch = batchSchema.parse({
    id: ID,
    name: 'Winter',
    createdBy: alice,
    createdAt: '2026-11-01T00:00:00Z',
    revision: 2,
    contentRevision: 1,
    status: 'draft',
    notBefore: null,
    zone: null,
    opId: null,
    scheduledContentRevision: null,
    claim: null,
    result: null,
    events: [],
  });
  f.moveData({
    '.publisher/PIN': pin,
    [path]: batch,
    [member]: {
      hash: 123,
      base: tooltip(),
      baseCommit: f.dataHead,
      proposed: tooltip('upcoming'),
      updatedAt: '2026-11-01T00:00:00Z',
      updatedBy: 'alice',
    },
  });
  // The existing shared fixture has no directory-contents endpoint. Only that metadata read
  // is supplied here; authentication, GraphQL, git writes, and ref CAS use the real route.
  const original = GitHub.prototype.result;
  vi.spyOn(GitHub.prototype, 'result').mockImplementation(function (
    this: GitHub,
    url,
    method,
    value,
  ) {
    if (url.startsWith(`/contents/schedule/batches/${ID}?ref=`))
      return Promise.resolve([
        { name: 'batch.json', type: 'file', sha: 'b'.repeat(40) },
        { name: 'tooltips', type: 'dir', sha: oid },
      ]);
    return original.call(this, url, method, value);
  });
});
afterEach(() => {
  scheduledConfig.enabled = false;
  publisherConfig.enabled = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('durable asynchronous admission', () => {
  it('archives legacy histories atomically and leaves a malformed advisory index untouched', async () => {
    const events = Array.from({ length: 200 }, (_, revision) => ({
      at: '2026-11-01T00:00:00Z',
      by: alice,
      action: 'save' as const,
      revision,
      contentRevision: 1,
    }));
    f.moveData({
      [path]: { ...storedBatch(), events },
      'schedule/index.json': { ignored: 'advisory only' },
    });
    expect((await call('schedule', scheduleBody())).status).toBe(202);
    expect(storedBatch().events).toHaveLength(20);
    expect(f.current()[`schedule/batches/${ID}/events/00000000.json`]).toEqual({
      events: events.slice(0, 181),
    });
    expect(storedBatch().events.slice(0, 19)).toEqual(events.slice(181));
    expect(f.current()['schedule/index.json']).toEqual({ ignored: 'advisory only' });
  });
  it.each(['schedule', 'save'] as const)(
    'queues %s without reading or validating member bodies',
    async (action) => {
      f.moveData({ [member]: { deliberately: 'invalid member, must be read only offline' } });
      const source = f.dataHead;
      const body = action === 'schedule' ? scheduleBody() : saveBody();
      const response = await call(action, body);
      expect(response.status).toBe(202);
      expect(response.body.message).toBe(
        action === 'schedule' ? 'Schedule requested' : 'Save queued',
      );
      expect(response.body.savedAt).toBeUndefined();
      expect(storedBatch()).toMatchObject({
        status: 'preparing',
        revision: 3,
        contentRevision: 1,
        preparation: {
          requestId: RID,
          kind: action,
          returnStatus: action === 'schedule' ? 'scheduled' : 'draft',
        },
        preparedRequestId: null,
      });
      expect(f.current()[member]).toEqual({
        deliberately: 'invalid member, must be read only offline',
      });
      const publicKey = await crypto.subtle.importKey(
        'spki',
        keypair.publicKey.export({ type: 'spki', format: 'der' }),
        'Ed25519',
        false,
        ['verify'],
      );
      const verified = await verifyScheduleRequest(
        record(),
        new TextEncoder().encode(JSON.stringify(body)),
        publicKey,
        { repo: 'test-org/scratch', dataBranch: f.env.DATA_BRANCH, liveBranch: f.env.LIVE_BRANCH },
      );
      expect(verified.intent).toMatchObject({
        sourceCommit: source,
        memberTreeOid: oid,
        requester: alice,
        expectedRevision: 2,
        contentRevision: 1,
      });
      expect(
        Object.keys(f.current()).filter((name) => name.startsWith('publish/requests/')),
      ).toEqual([]);
      const queries = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith('/graphql'))
        .map(([, init]) => JSON.parse(String(init?.body)).variables);
      expect(queries).toHaveLength(1);
      expect(Object.values(queries[0])).not.toContain(member);
      expect(Object.values(queries[0])).not.toContain('live/pushed.json');
      expect(Object.values(queries[0])).not.toContain('schedule/index.json');
      const writes = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith('/git/trees'))
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(
        writes[0].tree.find(
          (entry: { path: string }) => entry.path === scheduleIntentPaths.body(RID),
        ).content,
      ).toBe(JSON.stringify(body));
    },
  );
  it('keeps exact UTF-8 byte identity and rejects body/source/target tampering', async () => {
    const body = saveBody();
    await call('save', body);
    const key = await crypto.subtle.importKey(
      'spki',
      keypair.publicKey.export({ type: 'spki', format: 'der' }),
      'Ed25519',
      false,
      ['verify'],
    );
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const target = {
      repo: 'test-org/scratch',
      dataBranch: f.env.DATA_BRANCH,
      liveBranch: f.env.LIVE_BRANCH,
    };
    await expect(
      verifyScheduleRequest(
        record(),
        new TextEncoder().encode(JSON.stringify(body) + ' '),
        key,
        target,
      ),
    ).rejects.toThrow('signed intent');
    await expect(
      verifyScheduleRequest(record(), bytes, key, { ...target, liveBranch: 'other' }),
    ).rejects.toThrow('signed intent');
    const tampered = structuredClone(record());
    tampered.envelope.payload = tampered.envelope.payload.replace(oid, 'c'.repeat(40));
    await expect(verifyScheduleRequest(tampered, bytes, key, target)).rejects.toThrow('signature');
    await expect(
      verifyScheduleRequest({ ...record(), requesterId: 2 }, bytes, key, target),
    ).rejects.toThrow('signed intent');
    expect(await scheduleBodyDigest(bytes)).toBe(record().bodyDigest);
  });
  it('replays identical pending and completed requests, rejects changed input, and blocks another mutation', async () => {
    const body = saveBody();
    await call('save', body);
    const head = f.dataHead;
    expect((await call('save', body)).status).toBe(202);
    expect(f.dataHead).toBe(head);
    expect((await call('save', { ...body, message: 'Different' })).status).toBe(409);
    expect((await call('save', { ...body, requestId: OTHER, revision: 3 })).status).toBe(409);
    f.moveData({
      [path]: { ...storedBatch(), status: 'draft', preparation: null },
      [scheduleIntentPaths.request(RID)]: {
        ...record(),
        status: 'completed',
        result: { revision: 4, contentRevision: 2, status: 'draft' },
      },
    });
    expect((await call('save', body)).body.request.status).toBe('completed');
    const completed = await f.request(`/batches/${ID}/status?requestId=${RID}`, 'GET');
    expect(completed.status).toBe(200);
    expect(
      ((await completed.json()) as { request: ScheduleRequest }).request.result?.revision,
    ).toBe(4);
  });
  it('reconciles a successful CAS whose response was lost', async () => {
    const commit = GitHub.prototype.commit;
    vi.spyOn(GitHub.prototype, 'commit').mockImplementationOnce(async function (
      this: GitHub,
      ...args
    ) {
      await commit.apply(this, args);
      throw new Error('Lost response');
    });
    expect((await call('save', saveBody())).status).toBe(202);
    expect(f.commits).toHaveLength(1);
  });
  it('keeps the signed source unchanged through an unrelated ref race', async () => {
    const source = f.dataHead;
    f.beforePatch = () => f.moveData({ 'unrelated.json': { unchanged: true } });
    expect((await call('schedule', scheduleBody())).status).toBe(202);
    expect(JSON.parse(record().envelope.payload).sourceCommit).toBe(source);
    expect(f.commits).toHaveLength(2);
  });
  it('does not acknowledge a never-durable CAS', async () => {
    f.patchRaces = 4;
    expect((await call('save', saveBody())).status).toBe(409);
    expect(record()).toBeUndefined();
    expect(storedBatch().status).toBe('draft');
  });
  it('refuses old capabilities, missing signing key, disabled activation, and role loss', async () => {
    f.moveData({ '.publisher/PIN': { capabilities: ['scheduledBatches'] } });
    expect((await call('save', saveBody())).status).toBe(422);
    f.moveData({ '.publisher/PIN': pin });
    delete f.env.PUBLISH_SIGNING_KEY;
    expect((await call('save', saveBody())).status).toBe(503);
    f.env.PUBLISH_SIGNING_KEY = keypair.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    expect((await call('schedule', scheduleBody(), 4)).status).toBe(403);
    expect((await call('save', saveBody(), 3)).status).toBe(403);
    vi.mocked(switches.preparation).mockReturnValue(false);
    // The old strict API remains live, so a new-contract request is not silently queued.
    expect((await call('save', saveBody())).status).toBe(400);
    expect(record()).toBeUndefined();
  });
  it('bounds request bytes and counts before any commit', async () => {
    expect((await call('save', { ...saveBody(), message: 'x'.repeat(300 * 1024) })).status).toBe(
      413,
    );
    expect(
      (
        await call('save', {
          ...saveBody(),
          changes: Array.from({ length: 16 }, (_, hash) => ({ hash, base: null, next: null })),
        })
      ).status,
    ).toBe(400);
    expect((await call('schedule', { ...scheduleBody(), zone: 'Not/AZone' })).status).toBe(400);
    expect(
      (await call('schedule', { ...scheduleBody(), notBefore: nowMinute(Date.now()) })).status,
    ).toBe(422);
    expect(f.commits).toHaveLength(0);
  });
  it('restricts translator additions and scheduled-save count', async () => {
    expect(
      (await call('save', { ...saveBody(), changes: [{ hash: 456, base: null, next: {} }] }, 4))
        .status,
    ).toBe(403);
    scheduled();
    expect(
      (
        await call('save', {
          ...saveBody(),
          changes: Array.from({ length: 11 }, (_, hash) => ({ hash, base: null, next: {} })),
        })
      ).status,
    ).toBe(422);
  });
  it('withdraws scheduled publication atomically, preserving signed approval and due recovery', async () => {
    scheduled();
    expect((await call('save', saveBody())).status).toBe(202);
    expect(f.current()[`publish/requests/${OTHER}.json`]).toBeUndefined();
    expect(f.current()[scheduleIntentPaths.publication(ID)]).toEqual({
      payload: 'old signed approval',
      sig: 'old signature',
    });
    expect(storedBatch()).toMatchObject({
      status: 'preparing',
      opId: OTHER,
      preparation: { returnStatus: 'scheduled' },
    });
    expect(canClaimPreparedBatch(storedBatch(), RID)).toBe(false);
  });
});

describe('preparation cancellation, retry, and claim fences', () => {
  it.each(['retry', 'cancel'] as const)('reconciles a lost %s response', async (action) => {
    await call('save', saveBody());
    if (action === 'retry')
      f.moveData({
        [path]: { ...storedBatch(), status: 'needs_attention' },
        [scheduleIntentPaths.request(RID)]: {
          ...record(),
          status: 'needs_attention',
          retryable: true,
        },
      });
    const commit = GitHub.prototype.commit;
    vi.spyOn(GitHub.prototype, 'commit').mockImplementationOnce(async function (
      this: GitHub,
      ...args
    ) {
      await commit.apply(this, args);
      throw new Error('Lost response');
    });
    const response = await call(
      action,
      action === 'retry' ? { revision: 3, requestId: RID } : { revision: 3 },
    );
    expect(response.status).toBe(action === 'retry' ? 202 : 200);
    expect(f.commits).toHaveLength(2);
  });
  it.each(['unschedule', 'cancel'])(
    '%s fences late results and works with activation off',
    async (action) => {
      await call('schedule', scheduleBody());
      const pending = record();
      expect(matchesPreparationFence(storedBatch(), pending)).toBe(true);
      vi.mocked(switches.preparation).mockReturnValue(false);
      expect((await call(action, { revision: 3 })).status).toBe(200);
      expect(storedBatch().status).toBe(action === 'cancel' ? 'cancelled' : 'draft');
      expect(record().status).toBe('cancelled');
      expect(matchesPreparationFence(storedBatch(), pending)).toBe(false);
      expect(f.current()['schedule/due.json']).toEqual({ entries: [] });
      expect(f.current()[scheduleIntentPaths.body(RID)]).toEqual(scheduleBody());
    },
  );
  it('retries only infrastructure failure, preserves source, and fences the earlier attempt', async () => {
    await call('save', saveBody());
    const pending = record();
    f.moveData({
      [path]: { ...storedBatch(), status: 'needs_attention' },
      [scheduleIntentPaths.request(RID)]: {
        ...record(),
        status: 'needs_attention',
        retryable: true,
        reasons: [{ reason: 'Runner failed' }],
      },
    });
    const status = await call('status', undefined, 1, 'GET');
    expect(status.body.request.reasons).toEqual([{ reason: 'Runner failed' }]);
    expect((await call('retry', { revision: 3, requestId: RID })).status).toBe(202);
    expect(record().envelope).toEqual(pending.envelope);
    expect(record().attempt).toBe(2);
    expect(matchesPreparationFence(storedBatch(), pending)).toBe(false);
    expect(matchesPreparationFence(storedBatch(), record())).toBe(true);
    const head = f.dataHead;
    expect((await call('retry', { revision: 3, requestId: RID })).status).toBe(202);
    expect(f.dataHead).toBe(head);
  });
  it('blocks semantic retries and current role loss, and permits editing via return to draft', async () => {
    await call('save', saveBody());
    f.moveData({
      [path]: { ...storedBatch(), status: 'needs_attention' },
      [scheduleIntentPaths.request(RID)]: {
        ...record(),
        status: 'needs_attention',
        retryable: false,
        reasons: [{ reason: 'Stale source' }],
      },
    });
    expect((await call('retry', { revision: 3, requestId: RID })).status).toBe(409);
    f.moveData({
      'config/permissions.json': {
        users: { ...config.users, '1': { login: 'alice', role: 'trial' } },
      },
    });
    expect((await call('unschedule', { revision: 3 })).status).toBe(403);
    f.moveData({ 'config/permissions.json': config });
    expect((await call('unschedule', { revision: 3 })).status).toBe(200);
    expect(storedBatch().status).toBe('draft');
  });
  it('requires the matching ready ID and no pending request before claim', async () => {
    await call('schedule', scheduleBody());
    const batch = storedBatch();
    expect(batchSchema.safeParse({ ...batch, preparedRequestId: RID }).success).toBe(false);
    const ready = batchSchema.parse({
      ...batch,
      status: 'scheduled',
      preparation: null,
      preparedRequestId: RID,
      scheduledContentRevision: 1,
    });
    expect(canClaimPreparedBatch(ready, RID)).toBe(true);
    expect(canClaimPreparedBatch(ready, OTHER)).toBe(false);
    expect(canClaimPreparedBatch({ ...ready, preparation: batch.preparation }, RID)).toBe(false);
  });
});
