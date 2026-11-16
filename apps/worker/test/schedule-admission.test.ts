import { generateKeyPairSync } from 'node:crypto';
import { publishMonth } from '@clarity/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  batchSchema,
  canClaimPreparedBatch,
  matchesPreparationFence,
  nowMinute,
  scheduleBodyDigest,
  scheduleIntentPaths,
  schedulePreparationCapability,
  scheduleRequestSchema,
  verifyScheduleRequest,
  type Batch,
  type ScheduleRequest,
} from '@clarity/core/schedule';
import publisherConfig from '../../../config/publisher.json';
import scheduledConfig from '../../../config/scheduled.json';
import { GitHub } from '../src/github.js';
import { newUlid, switches } from '../src/schedule/store.js';
import { Fixture, config, makePrivateKey, tooltip } from './fixture.js';

const ID = '01K95H00000000000000000B01';
let RID: string;
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
  RID = newUlid();
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
  vi.useRealTimers();
  scheduledConfig.enabled = false;
  publisherConfig.enabled = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('durable asynchronous admission', () => {
  it.each(['request', 'log'])('refuses a schedule requestId already used by a publication %s', async (kind) => {
    const collision = kind === 'request' ? `publish/requests/${RID}.json` : `publish/log/${publishMonth(RID)}/${RID}.json`;
    f.moveData({ [collision]: { opaque: 'Only its OID is needed' } });
    const head = f.dataHead;
    expect((await call('schedule', scheduleBody())).status).toBe(409);
    expect(f.dataHead).toBe(head);
    expect(record()).toBeUndefined();
  });
  it.each([-2, 2])('rejects a new schedule ID %s days from now', async (days) => {
    const body = { ...scheduleBody(), requestId: newUlid(Date.now() + days * 86_400_000) };
    expect((await call('schedule', body)).status).toBe(400);
    expect(f.commits).toHaveLength(0);
  });
  it('replays an admitted schedule after its creation window has passed', async () => {
    const body = scheduleBody();
    expect((await call('schedule', body)).status).toBe(202);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect((await call('schedule', body)).status).toBe(202);
    expect(f.commits).toHaveLength(1);
  });
  it('fences a publication-ID collision introduced during a ref race', async () => {
    const collision = `publish/requests/${RID}.json`;
    f.beforePatch = () => f.moveData({ [collision]: { doNotOverwrite: true } });
    expect((await call('schedule', scheduleBody())).status).toBe(409);
    expect(record()).toBeUndefined();
    expect(f.current()[collision]).toEqual({ doNotOverwrite: true });
  });
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
      (await call('save', { ...saveBody(), changes: [{ hash: 456, base: null, next: { ...tooltip(), hash: 456 } }] }, 4))
        .status,
    ).toBe(403);
    scheduled();
    expect(
      (
        await call('save', {
          ...saveBody(),
          changes: Array.from({ length: 11 }, (_, hash) => ({ hash, base: null, next: { ...tooltip(), hash } })),
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
  it.each(['unschedule', 'cancel'] as const)('writes the withdrawn publication tombstone on %s of a scheduled save', async (action) => {
    scheduled();
    expect((await call('save', saveBody())).status).toBe(202);
    expect((await call(action, { revision: 3 })).status).toBe(200);
    expect(f.current()[`publish/log/${publishMonth(OTHER)}/${OTHER}.json`]).toMatchObject({
      request: { payload: 'old signed approval', sig: 'old signature' }, result: { status: 'cancelled', reason: action },
    });
  });
  it('terminally logs the old publication in the reschedule admission CAS', async () => {
    scheduled();
    expect((await call('schedule', scheduleBody())).status).toBe(202);
    expect(storedBatch().opId).toBe(RID);
    expect(f.current()[`publish/log/${publishMonth(OTHER)}/${OTHER}.json`]).toMatchObject({ result: { status: 'cancelled', reason: 'rescheduled' } });
    expect(f.current()[`publish/requests/${OTHER}.json`]).toBeUndefined();
  });
  it('restores a failed schedule due entry only on authenticated retry', async () => {
    expect((await call('schedule', scheduleBody())).status).toBe(202);
    const batch = storedBatch();
    f.moveData({ [path]: { ...batch, status: 'needs_attention' }, [scheduleIntentPaths.request(RID)]: { ...record(), status: 'needs_attention', retryable: true }, 'schedule/due.json': { entries: [] } });
    expect((await call('retry', { revision: 3, requestId: RID }, 3)).status).toBe(403);
    expect(f.current()['schedule/due.json']).toEqual({ entries: [] });
    expect((await call('retry', { revision: 3, requestId: RID })).status).toBe(202);
    expect(f.current()['schedule/due.json']).toEqual({ entries: [{ batchId: ID, opId: RID, notBefore: batch.notBefore, claimed: false }] });
  });
  it.each([null, {}, { hash: 123 }, { hash: 999, text: {} }, { hash: 123, text: { de: null } }])('rejects shallow-invalid translator saves before withdrawing a schedule (%j)', async (next) => {
    scheduled();
    const head = f.dataHead;
    expect((await call('save', { ...saveBody(), changes: [{ hash: 123, base: tooltip(), next }] }, 4)).status).toBe(400);
    expect(f.dataHead).toBe(head);
    expect(f.current()[`publish/requests/${OTHER}.json`]).toBeDefined();
    expect(storedBatch().status).toBe('scheduled');
  });
  it.each([[1, 'needs_attention'], [2, 'needs_attention'], [4, 'keep_scheduled']] as const)('signs the owner failure policy for role holder %s', async (user, onValidationFailure) => {
    scheduled();
    expect((await call('save', saveBody(), user)).status).toBe(202);
    expect(JSON.parse(record().envelope.payload)).toMatchObject({ kind: 'save', returnStatus: 'scheduled', onValidationFailure });
  });
  it('does not let an editor select the translator failure policy', async () => {
    scheduled();
    expect((await call('save', { ...saveBody(), onValidationFailure: 'keep_scheduled' })).status).toBe(400);
    expect(f.commits).toHaveLength(0);
  });
  it('exposes a translator save failure while the offline-restored accepted schedule stays claimable', async () => {
    scheduled();
    f.moveData({ [path]: { ...storedBatch(), preparedRequestId: OTHER } });
    const accepted = storedBatch();
    const originalMember = structuredClone(f.current()[member]);
    expect((await call('save', saveBody(), 4)).status).toBe(202);
    const pending = record();
    const failed = scheduleRequestSchema.parse({ ...pending, status: 'failed', reasons: [{ hash: 123, reason: 'Invalid translation number token' }] });
    // Simulate only B's contract output; this is not an execution of its future materializer.
    f.moveData({
      [path]: { ...accepted, revision: 4, preparation: null, lastPreparationFailure: { requestId: RID, at: failed.updatedAt, reason: failed.reasons![0].reason } },
      [scheduleIntentPaths.request(RID)]: failed,
      [`publish/requests/${OTHER}.json`]: f.current()[scheduleIntentPaths.publication(ID)],
    });
    const response = await f.request(`/batches/${ID}/status?requestId=${RID}`, 'GET', undefined, 2);
    const status = await response.json() as { request: ScheduleRequest; batch: Batch; savedAt?: number };
    expect(response.status).toBe(200);
    expect(status.request.status).toBe('failed');
    expect(status.request.result).toBeUndefined();
    expect(status.savedAt).toBeUndefined();
    expect(status.batch.lastPreparationFailure?.reason).toBe('Invalid translation number token');
    expect(canClaimPreparedBatch(status.batch, OTHER)).toBe(true);
    expect(matchesPreparationFence(status.batch, pending)).toBe(false);
    expect(f.current()[member]).toEqual(originalMember);
    expect(f.current()['schedule/due.json']).toEqual({ entries: [{ batchId: ID, opId: OTHER, notBefore: accepted.notBefore, claimed: false }] });
    expect(scheduleRequestSchema.safeParse({ ...failed, reasons: [] }).success).toBe(false);
    expect(scheduleRequestSchema.safeParse({ ...failed, result: { revision: 4, contentRevision: 1, status: 'scheduled' } }).success).toBe(false);
  });
  it.each([
    ['cancel', true],
    ['cancel', false],
    ['unschedule', true],
    ['unschedule', false],
  ] as const)('clears the ready fence on %s (activation=%s)', async (action, enabled) => {
    scheduled();
    f.moveData({ [path]: { ...storedBatch(), preparedRequestId: RID } });
    vi.mocked(switches.preparation).mockReturnValue(enabled);
    expect((await call(action, { revision: 2 })).status).toBe(200);
    expect(storedBatch()).toMatchObject({
      status: action === 'cancel' ? 'cancelled' : 'draft',
      preparedRequestId: null,
      opId: null,
    });
    expect(f.current()[`publish/requests/${OTHER}.json`]).toBeUndefined();
  });
  it.each(['pending', 'needs_attention'] as const)(
    'refuses schedule retry after the requester is downgraded to translator (%s)',
    async (status) => {
      await call('schedule', scheduleBody());
      f.moveData({
        'config/permissions.json': {
          users: {
            ...config.users,
            '1': { login: 'alice', role: 'translator', languages: ['de'] },
          },
        },
        [path]: {
          ...storedBatch(),
          status: status === 'pending' ? 'preparing' : 'needs_attention',
        },
        [scheduleIntentPaths.request(RID)]: { ...record(), status, retryable: true },
      });
      const head = f.dataHead;
      expect((await call('retry', { revision: 3, requestId: RID })).status).toBe(403);
      expect(f.dataHead).toBe(head);
      expect(record().attempt).toBe(1);
    },
  );
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
