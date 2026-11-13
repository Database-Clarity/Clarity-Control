import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash, publishMonth, type Tooltip } from '@clarity/core';
import {
  activate,
  approvedDigest,
  batchIntentDigest,
  batchPublishPayloadSchema,
  batchSchema,
  changedFields,
  dueSchema,
  nowMinute,
  scheduleIndexSchema,
  type Batch,
  type BatchMember,
} from '@clarity/core/schedule';
import publisherConfig from '../../../config/publisher.json';
import scheduledConfig from '../../../config/scheduled.json';
import worker from '../src/index.js';
import { eventArchivePath, newUlid } from '../src/schedule/store.js';
import { scheduleTick } from '../src/schedule/lifecycle.js';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

// Response bodies are read loosely; their shapes are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const ID = '01K95H00000000000000000B01';
const OTHER = '01K95H00000000000000000B02';
const dir = (id = ID) => `schedule/batches/${id}`;
const batchPath = (id = ID) => `${dir(id)}/batch.json`;
const memberPath = (hash = 123, id = ID) => `${dir(id)}/tooltips/${hash}.json`;
const alice = { id: 1, login: 'alice' };
const pin = { capabilities: ['elementTags', 'scheduledBatches'] };

// Roles in fixture config: 1 maintainer, 2 editor, 3 trial, 4 translator (de).
const MAINTAINER = 1;
const EDITOR = 2;
const TRIAL = 3;
const TRANSLATOR = 4;

const withText = (base: Tooltip, lang: 'en' | 'de' | 'fr', text: string): Tooltip => ({
  ...base,
  text: {
    ...base.text,
    [lang]: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice' },
  },
});

function draft(overrides: Partial<Batch> = {}): Batch {
  return batchSchema.parse({
    id: ID,
    name: 'December',
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
    events: [
      { at: '2026-11-01T00:00:00Z', by: alice, action: 'create', revision: 1, contentRevision: 0 },
      {
        at: '2026-11-01T00:01:00Z',
        by: alice,
        action: 'save',
        revision: 2,
        contentRevision: 1,
        hashes: [123],
      },
    ],
    ...overrides,
  });
}

function member(proposed: Tooltip, base: Tooltip | null = tooltip()): BatchMember {
  return {
    hash: proposed.hash,
    base,
    baseCommit: '1'.padStart(40, '0'),
    proposed,
    updatedAt: '2026-11-01T00:01:00Z',
    updatedBy: 'alice',
  };
}

let appKey: string;
let f: Fixture;
beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(() => {
  scheduledConfig.enabled = true;
  publisherConfig.enabled = true;
  f = new Fixture(appKey);
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  f.moveData({
    '.publisher/PIN': pin,
    [batchPath()]: draft(),
    [memberPath()]: member(withText(tooltip(), 'en', 'upcoming')),
    'schedule/index.json': {
      batches: [
        {
          id: ID,
          name: 'December',
          status: 'draft',
          notBefore: null,
          opId: null,
          revision: 2,
          hashes: [123],
          updatedAt: '2026-11-01T00:01:00Z',
        },
      ],
    },
  });
});
afterEach(() => {
  scheduledConfig.enabled = false;
  publisherConfig.enabled = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stored = (path: string) => f.current()[path];
const storedBatch = () => batchSchema.parse(stored(batchPath()));
async function call(path: string, value: unknown, id = MAINTAINER, method = 'POST') {
  f.subrequests = 0;
  const response = await f.request(path, method, value, id);
  return { status: response.status, body: (await response.json()) as Record<string, Loose> };
}
const saveBody = (next: Tooltip, base: Tooltip | null, revision = storedBatch().revision) => ({
  revision,
  changes: [{ hash: next.hash, base, next }],
  message: 'Stage',
});
const later = () => nowMinute(Date.now() + 30 * 60_000);
const schedule = (id = MAINTAINER, extra: Record<string, unknown> = {}) =>
  call(
    `/batches/${ID}/schedule`,
    { revision: storedBatch().revision, notBefore: later(), zone: 'Europe/Berlin', ...extra },
    id,
  );

describe('switch OFF', () => {
  it('answers 503 on every route before auth and the cron makes no I/O', async () => {
    scheduledConfig.enabled = false;
    const routes = [
      ['GET', '/batches'],
      ['POST', '/batches'],
      ...['save', 'rebase', 'remove', 'schedule', 'unschedule', 'cancel', 'resolve', 'kick'].map(
        (action) => ['POST', `/batches/${ID}/${action}`],
      ),
    ];
    f.subrequests = 0;
    for (const [method, path] of routes) {
      const response = await worker.fetch(
        new Request(`https://api.example${path}`, { method }),
        f.env,
        { waitUntil() {} },
      );
      expect([path, response.status]).toEqual([path, 503]);
    }
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ cron: '* * * * *' }, f.env, { waitUntil: (p) => pending.push(p) });
    expect(await Promise.all(pending)).toEqual([{ status: 'off' }]);
    expect(f.subrequests).toBe(0);
  });
  it('publisher OFF keeps the cron silent too, and the hourly trigger still purges', async () => {
    publisherConfig.enabled = false;
    f.subrequests = 0;
    expect(await scheduleTick(f.env)).toEqual({ status: 'off' });
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ cron: '0 * * * *' }, f.env, { waitUntil: (p) => pending.push(p) });
    // purgeReports without its databases refuses; it is the hourly path, not the tick.
    await expect(pending[0]).rejects.toThrow('Reports are unavailable');
    expect(f.subrequests).toBe(0);
  });
});

describe('role x route matrix on stored members', () => {
  it('GET /batches: maintainer, editor, and translator read; trials get nothing (Q3)', async () => {
    for (const [id, status] of [
      [MAINTAINER, 200],
      [EDITOR, 200],
      [TRANSLATOR, 200],
      [TRIAL, 403],
    ] as const) {
      const response = await call('/batches', undefined, id, 'GET');
      expect([id, response.status]).toEqual([id, status]);
    }
    const ok = await call('/batches', undefined, EDITOR, 'GET');
    expect(ok.body.head).toBe(f.dataHead);
    expect(ok.body.index.batches[0].id).toBe(ID);
    expect(f.subrequests).toBe(2);
  });

  it('POST /batches: maintainer and editor create; trial and translator are refused', async () => {
    for (const id of [TRIAL, TRANSLATOR])
      expect((await call('/batches', { name: 'Next' }, id)).status).toBe(403);
    const created = await call('/batches', { name: 'Next' }, EDITOR);
    expect(created.status).toBe(201);
    expect(f.subrequests).toBe(5);
    const batch = batchSchema.parse(stored(`${dir(created.body.batch.id)}/batch.json`));
    expect(batch).toMatchObject({ status: 'draft', revision: 1, contentRevision: 0 });
    expect(scheduleIndexSchema.parse(stored('schedule/index.json')).batches).toHaveLength(2);
  });

  it('save: editors edit and add; translators only their language on existing members; trials never', async () => {
    const current = member(withText(tooltip(), 'en', 'upcoming')).proposed;
    // Trial: refused outright (Q3).
    expect(
      (await call(`/batches/${ID}/save`, saveBody(withText(current, 'de', 'x'), current), TRIAL))
        .status,
    ).toBe(403);
    // Translator: assigned language on an existing member.
    const de = await call(
      `/batches/${ID}/save`,
      saveBody(withText(current, 'de', 'Kommend'), current),
      TRANSLATOR,
    );
    expect(de.status).toBe(200);
    expect(de.body.batch.contentRevision).toBe(1); // translation-only save: content unchanged
    const afterDe = (stored(memberPath()) as BatchMember).proposed;
    // Translator: another language, English, and adding a tooltip are refused.
    expect(
      (
        await call(
          `/batches/${ID}/save`,
          saveBody(withText(afterDe, 'fr', 'x'), afterDe),
          TRANSLATOR,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          `/batches/${ID}/save`,
          saveBody(withText(afterDe, 'en', 'x'), afterDe),
          TRANSLATOR,
        )
      ).status,
    ).toBe(403);
    f.moveData({ 'tooltips/456.json': { ...tooltip(), hash: 456 } });
    const added = withText({ ...tooltip(), hash: 456 }, 'en', 'new 456');
    expect(
      (await call(`/batches/${ID}/save`, saveBody(added, { ...tooltip(), hash: 456 }), TRANSLATOR))
        .status,
    ).toBe(403);
    // Editor: English edit and an add.
    const en = await call(
      `/batches/${ID}/save`,
      saveBody(withText(afterDe, 'en', 'v2'), afterDe),
      EDITOR,
    );
    expect(en.status).toBe(200);
    expect(en.body.batch.contentRevision).toBe(2);
    expect(f.subrequests).toBe(6);
    const add = await call(
      `/batches/${ID}/save`,
      saveBody(added, { ...tooltip(), hash: 456 }),
      EDITOR,
    );
    expect(add.status).toBe(200);
    expect(f.subrequests).toBe(8); // + aliases (canonical check) + the Q2 listing
    expect((stored(memberPath(456)) as BatchMember).base).toEqual({ ...tooltip(), hash: 456 });
    expect(scheduleIndexSchema.parse(stored('schedule/index.json')).batches[0]!.hashes).toEqual([
      123, 456,
    ]);
  });

  it('archive rules apply to batch members exactly as to /save (R5)', async () => {
    const current = (stored(memberPath()) as BatchMember).proposed;
    const archived = {
      ...current,
      archive: {
        removedAt: '2026-10-02T00:00:00Z',
        lastSeen: { name: 'Old', categoryId: 'perk', manifestVersion: 'pinned' },
      },
    } as Tooltip;
    // Editor may not stage an archive creation.
    expect((await call(`/batches/${ID}/save`, saveBody(archived, current), EDITOR)).status).toBe(
      403,
    );
    // The maintainer may; then the editor may not edit its archive metadata, but may unarchive.
    expect(
      (await call(`/batches/${ID}/save`, saveBody(archived, current), MAINTAINER)).status,
    ).toBe(200);
    const meta = {
      ...archived,
      archive: { ...archived.archive!, removedAt: '2026-10-03T00:00:00Z' },
    } as Tooltip;
    expect((await call(`/batches/${ID}/save`, saveBody(meta, archived), EDITOR)).status).toBe(403);
    expect((await call(`/batches/${ID}/save`, saveBody(current, archived), EDITOR)).status).toBe(
      200,
    );
  });

  it('rebase and remove: maintainer and editor only', async () => {
    const proposed = (stored(memberPath()) as BatchMember).proposed;
    f.moveData({ 'tooltips/123.json': withText(tooltip(), 'fr', 'courant') });
    const rebase = (id: number) =>
      call(
        `/batches/${ID}/rebase`,
        {
          revision: storedBatch().revision,
          hash: 123,
          base: withText(tooltip(), 'fr', 'courant'),
          next: withText(proposed, 'fr', 'courant'),
        },
        id,
      );
    for (const id of [TRIAL, TRANSLATOR]) expect((await rebase(id)).status).toBe(403);
    const ok = await rebase(EDITOR);
    expect(ok.status).toBe(200);
    expect(f.subrequests).toBe(6);
    expect((stored(memberPath()) as BatchMember).base).toEqual(
      withText(tooltip(), 'fr', 'courant'),
    );
    const remove = (id: number) =>
      call(`/batches/${ID}/remove`, { revision: storedBatch().revision, hashes: [123] }, id);
    for (const id of [TRIAL, TRANSLATOR]) expect((await remove(id)).status).toBe(403);
    expect((await remove(EDITOR)).status).toBe(200);
    expect(stored(memberPath())).toBeUndefined();
    expect(storedBatch().contentRevision).toBe(3);
  });

  it('schedule, unschedule, cancel, kick, resolve: maintainer and editor only', async () => {
    for (const id of [TRIAL, TRANSLATOR]) {
      expect((await schedule(id)).status).toBe(403);
      for (const action of ['unschedule', 'cancel'])
        expect((await call(`/batches/${ID}/${action}`, { revision: 2 }, id)).status).toBe(403);
      expect((await call(`/batches/${ID}/kick`, {}, id)).status).toBe(403);
      expect(
        (
          await call(
            `/batches/${ID}/resolve`,
            { hash: 123, expectedCurrent: null, choices: {} },
            id,
          )
        ).status,
      ).toBe(403);
    }
    expect((await schedule(EDITOR)).status).toBe(202);
    expect(
      (await call(`/batches/${ID}/unschedule`, { revision: storedBatch().revision }, EDITOR))
        .status,
    ).toBe(200);
    expect(
      (await call(`/batches/${ID}/cancel`, { revision: storedBatch().revision }, MAINTAINER))
        .status,
    ).toBe(200);
    expect(storedBatch().status).toBe('cancelled');
  });
});

describe('schedule', () => {
  it('writes the signed request, batch.json, due.json, and the index in ONE commit', async () => {
    const commits = f.commits.length;
    const response = await schedule();
    expect(response.status).toBe(202);
    expect(f.commits.length).toBe(commits + 1);
    expect(f.subrequests).toBeLessThanOrEqual(15); // ≈ /publish (≤13) + 2 member reads
    const opId = response.body.opId as string;
    const batch = storedBatch();
    expect(batch).toMatchObject({
      status: 'scheduled',
      opId,
      scheduledContentRevision: 1,
      revision: 3,
      contentRevision: 1,
    });
    expect(batch.events.at(-1)).toMatchObject({
      action: 'schedule',
      notBefore: batch.notBefore,
      hashes: [123],
    });
    expect(dueSchema.parse(stored('schedule/due.json')).entries).toEqual([
      { batchId: ID, opId, notBefore: batch.notBefore, claimed: false },
    ]);
    const envelope = stored(`publish/requests/${opId}.json`) as { payload: string; sig: string };
    const payload = batchPublishPayloadSchema.parse(JSON.parse(envelope.payload));
    const publicKey = createPublicKey(
      (
        (await (
          await worker.fetch(new Request('https://api.example/publish/key'), f.env, {
            waitUntil() {},
          })
        ).json()) as { publicKey: string }
      ).publicKey,
    );
    expect(
      verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.sig, 'base64')),
    ).toBe(true);
    const m = stored(memberPath()) as BatchMember;
    expect(payload.approvedDigest).toBe(await approvedDigest([m]));
    const { createdAt, intentDigest, ...intent } = payload;
    expect(createdAt).toBe(storedBatch().events.at(-1)!.at);
    expect(intentDigest).toBe(await batchIntentDigest(intent));
    expect(payload).toMatchObject({
      kind: 'batch',
      batchId: ID,
      contentRevision: 1,
      hashes: [123],
      requester: alice,
    });
    // A first publication (C4) is reported for the approver.
    expect(response.body.firstPublications).toEqual([123]);
  });

  it('reschedule retires the old request with a cancelled log; publish/status says cancelled', async () => {
    const first = (await schedule()).body.opId as string;
    const second = await schedule(EDITOR, { notBefore: nowMinute(Date.now() + 60 * 60_000) });
    expect(second.status).toBe(202);
    expect(stored(`publish/requests/${first}.json`)).toBeUndefined();
    const log = stored(`publish/log/${publishMonth(first)}/${first}.json`) as Record<string, Loose>;
    expect(log.result).toMatchObject({ status: 'cancelled', reason: 'rescheduled' });
    expect(storedBatch().events.at(-1)!.action).toBe('reschedule');
    expect(dueSchema.parse(stored('schedule/due.json')).entries).toHaveLength(1);
    const status = await call(`/publish/status?opId=${first}`, undefined, MAINTAINER, 'GET');
    expect(status.body.operations[0].status).toBe('cancelled');
  });

  it('refuses without the PIN capability, on a stale revision, and with no members', async () => {
    f.moveData({ '.publisher/PIN': { capabilities: ['elementTags'] } });
    expect((await schedule()).status).toBe(422);
    f.moveData({ '.publisher/PIN': pin });
    const stale = await call(`/batches/${ID}/schedule`, {
      revision: 1,
      notBefore: later(),
      zone: 'UTC',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toEqual({ revision: 2 });
    f.moveData({ [memberPath()]: undefined });
    expect((await schedule()).status).toBe(422);
  });

  it('refuses times too soon, too late, and unknown zones; accepts now', async () => {
    expect((await schedule(MAINTAINER, { notBefore: nowMinute(Date.now() + 60_000) })).status).toBe(
      422,
    );
    expect(
      (await schedule(MAINTAINER, { notBefore: nowMinute(Date.now() + 400 * 86_400_000) })).status,
    ).toBe(422);
    expect((await schedule(MAINTAINER, { zone: 'Mars/Olympus' })).status).toBe(400);
    const now = await schedule(MAINTAINER, { notBefore: 'now' });
    expect(now.status).toBe(202);
    expect(storedBatch().notBefore! <= new Date().toISOString()).toBe(true);
  });

  it('refuses unpublished fields (root ruling), a missing snapshot (C3), and $exists staleness', async () => {
    // Live moved past base on English: the batch value would also carry unpublished work.
    f.moveData({
      'live/pushed.json': { 123: 'a'.repeat(64) },
      'live/tooltips/123.json': withText(tooltip(), 'en', 'published earlier'),
    });
    const unpublished = await schedule();
    expect(unpublished.status).toBe(409);
    expect(unpublished.body.error).toContain('not published yet');
    expect(unpublished.body.details.members).toEqual([{ hash: 123, fields: ['text.en'] }]);
    f.moveData({ 'live/tooltips/123.json': undefined });
    const c3 = await schedule();
    expect(c3.status).toBe(409);
    expect(c3.body.details.members[0].reason).toContain('No published snapshot');
    f.moveData({ 'live/pushed.json': {}, 'tooltips/123.json': undefined });
    const exists = await schedule();
    expect(exists.status).toBe(409);
    expect(exists.body.details.members).toEqual([{ hash: 123, fields: ['$exists'] }]);
  });

  it('a clean overlay schedules; a non-translation conflict with current is stale', async () => {
    f.moveData({
      'live/pushed.json': { 123: 'a'.repeat(64) },
      'live/tooltips/123.json': tooltip(),
    });
    expect((await schedule()).status).toBe(202);
    await call(`/batches/${ID}/unschedule`, { revision: storedBatch().revision });
    f.moveData({ 'tooltips/123.json': withText(tooltip(), 'en', 'someone else') });
    const stale = await schedule();
    expect(stale.status).toBe(409);
    expect(stale.body.details.members).toEqual([{ hash: 123, fields: ['text.en'] }]);
  });

  it('a conflict file blocks scheduling that hash', async () => {
    f.moveData({ 'schedule/activation-conflicts/123.json': { hash: 123 } });
    const response = await schedule();
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Resolve the batch activation first');
  });

  it('caps scheduled batches at 50 from due.json', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      batchId: newUlid(Date.now() + index),
      opId: newUlid(Date.now() + index),
      notBefore: later(),
      claimed: false,
    }));
    f.moveData({ 'schedule/due.json': { entries } });
    expect((await schedule()).status).toBe(409);
  });
});

describe('claim refusals and status rules', () => {
  const claimed = () => {
    const opId = newUlid();
    f.moveData({
      [batchPath()]: draft({
        status: 'publishing',
        opId,
        notBefore: nowMinute(Date.now() - 20 * 60_000),
        zone: 'UTC',
        scheduledContentRevision: 1,
        claim: { opId, claimedAt: new Date().toISOString() },
      }),
    });
    return opId;
  };
  it('refuses every batch write once the publisher claimed the batch (I2)', async () => {
    claimed();
    const proposed = (stored(memberPath()) as BatchMember).proposed;
    const writes = [
      call(`/batches/${ID}/save`, saveBody(withText(proposed, 'de', 'x'), proposed)),
      call(`/batches/${ID}/rebase`, { revision: 2, hash: 123, base: tooltip(), next: proposed }),
      call(`/batches/${ID}/remove`, { revision: 2, hashes: [123] }),
      call(`/batches/${ID}/schedule`, { revision: 2, notBefore: later(), zone: 'UTC' }),
      call(`/batches/${ID}/unschedule`, { revision: 2 }),
      call(`/batches/${ID}/cancel`, { revision: 2 }),
    ];
    for (const response of await Promise.all(writes)) {
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Publishing started');
    }
  });
  it('kick: only overdue, claimed-but-not-terminal or scheduled batches, one per minute', async () => {
    expect((await call(`/batches/${ID}/kick`, {})).status).toBe(409); // draft
    claimed();
    const kick = await call(`/batches/${ID}/kick`, {});
    expect(kick.status).toBe(202);
    expect(f.subrequests).toBe(3);
    expect([...f.kicks][0]).toMatch(new RegExp(`/contents/publish/kicks/batch-${ID}-\\d+\\.json$`));
    expect((await call(`/batches/${ID}/kick`, {})).status).toBe(202); // duplicate name: ignored
    expect(f.kicks.size).toBe(1);
  });
  it('a scheduled batch takes translation edits only (Unschedule to edit)', async () => {
    await schedule();
    const proposed = (stored(memberPath()) as BatchMember).proposed;
    const de = await call(
      `/batches/${ID}/save`,
      saveBody(withText(proposed, 'de', 'Kommend'), proposed),
      TRANSLATOR,
    );
    expect(de.status).toBe(200);
    expect(storedBatch()).toMatchObject({
      status: 'scheduled',
      contentRevision: 1,
      scheduledContentRevision: 1,
    });
    const afterDe = (stored(memberPath()) as BatchMember).proposed;
    const en = await call(
      `/batches/${ID}/save`,
      saveBody(withText(afterDe, 'en', 'v3'), afterDe),
      EDITOR,
    );
    expect([en.status, en.body.error]).toEqual([409, 'Unschedule to edit']);
    expect(
      (await call(`/batches/${ID}/remove`, { revision: storedBatch().revision, hashes: [123] }))
        .status,
    ).toBe(409);
  });
  it('unschedule and cancel write the cancelled log and clear due.json', async () => {
    const opId = (await schedule()).body.opId as string;
    const response = await call(`/batches/${ID}/unschedule`, { revision: storedBatch().revision });
    expect(response.status).toBe(200);
    expect(f.subrequests).toBe(6);
    expect(storedBatch()).toMatchObject({ status: 'draft', opId: null, notBefore: null });
    expect(stored(`publish/requests/${opId}.json`)).toBeUndefined();
    expect((stored(`publish/log/${publishMonth(opId)}/${opId}.json`) as Loose).result.status).toBe(
      'cancelled',
    );
    expect(dueSchema.parse(stored('schedule/due.json')).entries).toEqual([]);
    expect(
      (await call(`/batches/${ID}/unschedule`, { revision: storedBatch().revision })).status,
    ).toBe(409);
  });
});

describe('Q2 one open batch per tooltip', () => {
  const other = (status: Batch['status']) => {
    const base = draft({ id: OTHER, name: 'Other' });
    const value =
      status === 'cancelled' ? batchSchema.parse({ ...base, status: 'cancelled' }) : base;
    f.moveData({
      [batchPath(OTHER)]: value,
      [memberPath(456, OTHER)]: member(withText({ ...tooltip(), hash: 456 }, 'en', 'other'), {
        ...tooltip(),
        hash: 456,
      }),
      'tooltips/456.json': { ...tooltip(), hash: 456 },
    });
  };
  const add = () =>
    call(
      `/batches/${ID}/save`,
      saveBody(withText({ ...tooltip(), hash: 456 }, 'en', 'mine'), { ...tooltip(), hash: 456 }),
    );
  it('refuses a tooltip that another open batch holds, from stored members at the head', async () => {
    other('draft');
    const response = await add();
    expect(response.status).toBe(409);
    expect(response.body.details).toEqual({ hashes: [456], batchId: OTHER });
  });
  it('a terminal batch does not hold its old members', async () => {
    other('cancelled');
    expect((await add()).status).toBe(200);
  });
  it('the index is never the guard', async () => {
    other('draft');
    f.moveData({ 'schedule/index.json': { batches: [] } });
    expect((await add()).status).toBe(409);
  });
});

describe('save semantics', () => {
  it('merges against the stored proposal and reports conflicts like /save', async () => {
    const storedProposal = (stored(memberPath()) as BatchMember).proposed;
    // A client that started before a translator's save still merges cleanly.
    await call(
      `/batches/${ID}/save`,
      saveBody(withText(storedProposal, 'de', 'Kommend'), storedProposal),
      TRANSLATOR,
    );
    const merged = await call(
      `/batches/${ID}/save`,
      saveBody(withText(storedProposal, 'en', 'v2'), storedProposal),
      EDITOR,
    );
    expect(merged.status).toBe(200);
    const after = (stored(memberPath()) as BatchMember).proposed;
    expect([after.text.en?.text, after.text.de?.text]).toEqual(['v2', 'Kommend']);
    // Two edits of the same field conflict.
    const conflict = await call(
      `/batches/${ID}/save`,
      saveBody(withText(storedProposal, 'en', 'v3'), storedProposal),
      EDITOR,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.conflicts[0].fields).toEqual(['text.en']);
  });
  it('an add must start from current at the head', async () => {
    const response = await call(
      `/batches/${ID}/save`,
      saveBody(withText({ ...tooltip(), hash: 456 }, 'en', 'x'), { ...tooltip(), hash: 456 }),
    );
    expect(response.status).toBe(409);
    expect(response.body.conflicts[0].fields).toEqual(['$exists']);
  });
  it('a stamp-only save is a no-op', async () => {
    const proposal = (stored(memberPath()) as BatchMember).proposed;
    const restamped = {
      ...proposal,
      text: { ...proposal.text, en: { ...proposal.text.en!, updatedAt: '2026-11-12T00:00:00Z' } },
    };
    const commits = f.commits.length;
    const response = await call(`/batches/${ID}/save`, saveBody(restamped, proposal));
    expect(response.body.commit).toBeNull();
    expect(f.commits.length).toBe(commits);
  });
  it('refuses a stored member over the byte cap', async () => {
    const proposal = (stored(memberPath()) as BatchMember).proposed;
    const huge = withText(proposal, 'de', 'x'.repeat(30 * 1024));
    expect((await call(`/batches/${ID}/save`, saveBody(huge, proposal))).status).toBe(413);
  });
  it('moves overflowing events to events/<seq>.json in the same commit (root ruling)', async () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      at: '2026-11-01T00:00:00Z',
      by: alice,
      action: 'save' as const,
      revision: 2,
      contentRevision: 1,
      hashes: [index],
    }));
    f.moveData({ [batchPath()]: draft({ events: many }) });
    const proposal = (stored(memberPath()) as BatchMember).proposed;
    await call(`/batches/${ID}/save`, saveBody(withText(proposal, 'de', 'a'), proposal));
    expect(stored(eventArchivePath(ID, 0))).toEqual({ events: [many[0]] });
    expect(storedBatch().events).toHaveLength(200);
    expect(storedBatch().events[0]).toEqual(many[1]);
    const next = (stored(memberPath()) as BatchMember).proposed;
    const response = await call(`/batches/${ID}/save`, saveBody(withText(next, 'de', 'b'), next));
    expect(response.status).toBe(200);
    expect(stored(eventArchivePath(ID, 1))).toEqual({ events: [many[1]] });
    expect(eventArchivePath(ID, 1)).toBe(`${dir()}/events/00000001.json`);
  });
});

describe('resolve', () => {
  const published = () => {
    const opId = newUlid();
    const base = tooltip();
    const proposed = withText(withText(base, 'en', 'upcoming'), 'de', 'Kommend');
    const current = withText(base, 'en', 'edited meanwhile');
    f.moveData({
      [batchPath()]: draft({
        status: 'published',
        opId,
        notBefore: nowMinute(Date.now() - 60 * 60_000),
        zone: 'UTC',
        scheduledContentRevision: 1,
        claim: { opId, claimedAt: '2026-11-13T10:00:00Z' },
        result: {
          opId,
          status: 'published',
          landedAt: '2026-11-13T10:01:00Z',
          landedAtSource: 'cas',
          recordedAt: '2026-11-13T10:02:00Z',
          exportNow: '2026-11-13T10:00:30Z',
          liveCommit: '2'.padStart(40, '0'),
        },
      }),
      'tooltips/123.json': current,
      'schedule/activation-conflicts/123.json': {
        hash: 123,
        batchId: ID,
        opId,
        fields: (activate({ base, current, proposed }) as { fields: string[] }).fields,
        changed: changedFields(base, proposed),
        base,
        proposed,
        currentAtRecord: current,
      },
    });
    return { base, proposed, current };
  };
  it('applies clean fields, requires a choice per conflict, and deletes the file in one commit', async () => {
    const { current } = published();
    const expectedCurrent = await contentHash(current);
    const missing = await call(`/batches/${ID}/resolve`, {
      hash: 123,
      expectedCurrent,
      choices: {},
    });
    expect([missing.status, missing.body.missing]).toEqual([409, ['text.en']]);
    const moved = await call(`/batches/${ID}/resolve`, {
      hash: 123,
      expectedCurrent: 'f'.repeat(64),
      choices: { 'text.en': 'current' },
    });
    expect(moved.status).toBe(409);
    expect(moved.body.current).toEqual(current);
    const ok = await call(`/batches/${ID}/resolve`, {
      hash: 123,
      expectedCurrent,
      choices: { 'text.en': 'current' },
    });
    expect(ok.status).toBe(200);
    expect(f.subrequests).toBe(5);
    const written = stored('tooltips/123.json') as Tooltip;
    expect([written.text.en?.text, written.text.de?.text]).toEqual(['edited meanwhile', 'Kommend']);
    expect(stored('schedule/activation-conflicts/123.json')).toBeUndefined();
    expect(storedBatch().events.at(-1)).toMatchObject({ action: 'resolve', hashes: [123] });
    expect(String(f.commits.at(-1)!.message).trimEnd().split('\n').at(-1)).toBe(
      'Clarity-Changed: 123=de',
    );
  });
  it('maps an existence choice that no longer applies to 409 with per-field missing', async () => {
    const { current } = published();
    const response = await call(`/batches/${ID}/resolve`, {
      hash: 123,
      expectedCurrent: await contentHash(current),
      choices: { $exists: 'upcoming' },
    });
    expect(response.status).toBe(409);
    expect(response.body.missing).toEqual(['text.en']);
  });
  it('refuses choices for fields the batch does not change', async () => {
    const { current } = published();
    const response = await call(`/batches/${ID}/resolve`, {
      hash: 123,
      expectedCurrent: await contentHash(current),
      choices: { 'text.en': 'current', custom: 'upcoming' },
    });
    expect(response.status).toBe(400);
  });
});

describe('cron tick', () => {
  const due = (notBefore: string, claimed = false) =>
    f.moveData({
      'schedule/due.json': { entries: [{ batchId: ID, opId: newUlid(), notBefore, claimed }] },
    });
  it('kicks at most once per name, re-kicks a stuck set every 10 minutes, and skips not-due work', async () => {
    due(nowMinute(Date.now() + 10 * 60_000));
    f.subrequests = 0;
    expect(await scheduleTick(f.env)).toEqual({ status: 'idle' });
    expect(f.subrequests).toBe(2);
    const notBefore = nowMinute(Date.now() - 60_000);
    due(notBefore, true); // a claimed entry whose run died still counts (R11)
    const now = Date.now();
    f.subrequests = 0;
    const first = await scheduleTick(f.env, now);
    expect(first.status).toBe('kicked');
    expect(f.subrequests).toBe(3);
    const compact = notBefore.slice(0, 16).replace(/[-T:]/g, '');
    expect(first).toMatchObject({
      path: `publish/kicks/due-${compact}-${Math.floor(now / 600_000)}.json`,
    });
    expect((await scheduleTick(f.env, now)).status).toBe('duplicate');
    expect((await scheduleTick(f.env, now + 10 * 60_000)).status).toBe('kicked');
    expect(f.kicks.size).toBe(2);
  });
  it('dispatches by event.cron: the minute trigger never purges reports', async () => {
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ cron: '* * * * *' }, f.env, { waitUntil: (p) => pending.push(p) });
    expect(await Promise.all(pending)).toEqual([{ status: 'idle' }]);
  });
});

describe('/publish admission with the switch ON', () => {
  it('refuses hashes with an activation conflict file in the same read', async () => {
    const { publishableHash } = await import('@clarity/core');
    f.moveData({ 'schedule/activation-conflicts/123.json': { hash: 123 } });
    const opId = newUlid();
    const response = await call('/publish', {
      opId,
      hashes: [123],
      expected: { 123: await publishableHash(tooltip(), f.aliases) },
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('unresolved batch activation');
    // Same subrequests as an accepted publish's reads: the listing joins the snapshot.
    f.moveData({
      'schedule/activation-conflicts/123.json': undefined,
      'schedule/activation-conflicts/9.json': { hash: 9 },
    });
    const accepted = await call('/publish', {
      opId: newUlid(),
      hashes: [123],
      expected: { 123: await publishableHash(tooltip(), f.aliases) },
    });
    expect(accepted.status).toBe(202);
    expect(f.subrequests).toBe(7);
  });
});

describe('GitHub.publishSnapshot trees (names-only listing)', () => {
  it('lists nested names in the same single read, null for a missing directory', async () => {
    const { GitHub } = await import('../src/github.js');
    const github = new GitHub(f.env);
    f.subrequests = 0;
    const snapshot = await github.publishSnapshot(
      ['config/permissions.json'],
      [],
      [
        { path: 'schedule/batches', depth: 3 },
        { path: 'schedule/activation-conflicts', depth: 1 },
      ],
    );
    expect(f.subrequests).toBe(2); // token + ONE GraphQL
    expect(snapshot.trees[1]).toBeNull();
    const batchDir = snapshot.trees[0]!.find(({ name }) => name === ID)!;
    expect(batchDir.entries).toEqual([
      { name: 'batch.json' },
      { name: 'tooltips', entries: [{ name: '123.json' }] },
    ]);
  });
  it('keeps the query unchanged without trees and refuses bad listing paths', async () => {
    const { GitHub } = await import('../src/github.js');
    const github = new GitHub(f.env);
    await expect(github.publishSnapshot([], [], [{ path: '../x', depth: 1 }])).rejects.toThrow(
      'Invalid publish paths',
    );
    await expect(github.publishSnapshot([], [], [{ path: 'schedule', depth: 4 }])).rejects.toThrow(
      'Invalid publish paths',
    );
    const calls = (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls;
    await github.publishSnapshot(['config/permissions.json']);
    const query = JSON.parse(String(calls.at(-1)![1].body)).query as string;
    expect(query).toBe(
      'query($owner:String!,$name:String!,$branch:String!,$p0:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$branch){target{... on Commit{oid tree{oid} o0:file(path:$p0){object{... on Blob{oid isTruncated text}}}}}}}}',
    );
  });
});

describe('Worker caps (CPU gate, root option A)', () => {
  it('admits at most memberCap members per batch and saveChangeCap changes per save', async () => {
    const { memberCap, saveChangeCap } = await import('../src/schedule/store.js');
    expect([memberCap, saveChangeCap]).toEqual([15, 15]);
    const hashes = Array.from({ length: memberCap }, (_, i) => 1000 + i);
    const files: Record<string, unknown> = {};
    for (const hash of hashes) {
      files[`tooltips/${hash}.json`] = { ...tooltip(), hash };
      files[memberPath(hash)] = member(withText({ ...tooltip(), hash }, 'en', 'x'), {
        ...tooltip(),
        hash,
      });
    }
    f.moveData(files);
    // 123 + 25 = 26 members: refused at schedule; one more add is refused at save.
    const schedule26 = await schedule();
    expect([schedule26.status, schedule26.body.error]).toEqual([
      422,
      `A batch publishes at most ${memberCap} tooltips; remove some first`,
    ]);
    f.moveData({ 'tooltips/9999.json': { ...tooltip(), hash: 9999 } });
    const add = await call(
      `/batches/${ID}/save`,
      saveBody(withText({ ...tooltip(), hash: 9999 }, 'en', 'y'), { ...tooltip(), hash: 9999 }),
    );
    expect(add.status).toBe(409);
    const tooMany = await call(`/batches/${ID}/save`, {
      revision: storedBatch().revision,
      changes: Array.from({ length: saveChangeCap + 1 }, (_, i) => ({
        hash: 2000 + i,
        base: null,
        next: { ...tooltip(), hash: 2000 + i },
      })),
      message: 'Too many',
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('round-1 review fixes', () => {
  it('never stores a stamp-only difference (scheduled translation save keeps English stamps, I5)', async () => {
    await schedule();
    const old = stored(memberPath()) as BatchMember;
    const digest = await approvedDigest([old]);
    const next: Tooltip = {
      ...old.proposed,
      text: {
        ...old.proposed.text,
        en: { ...old.proposed.text.en!, updatedAt: '2027-11-01T00:00:00Z' },
        de: { text: 'Kommend', updatedAt: '2026-11-13T00:00:00Z', updatedBy: 'dan' },
      },
    };
    const response = await call(`/batches/${ID}/save`, saveBody(next, old.proposed), EDITOR);
    expect(response.status).toBe(200);
    const after = stored(memberPath()) as BatchMember;
    expect(after.proposed.text.en).toEqual(old.proposed.text.en);
    expect(after.proposed.text.de?.text).toBe('Kommend');
    expect(await approvedDigest([after])).toBe(digest);
    expect(storedBatch().contentRevision).toBe(1);
  });
  it('adds keep current values for stamp-only fields', async () => {
    const current = { ...tooltip(), hash: 456 };
    f.moveData({ 'tooltips/456.json': current });
    const next = withText(
      { ...current, text: { en: { ...current.text.en!, updatedAt: '2027-01-01T00:00:00Z' } } },
      'de',
      'neu',
    );
    expect((await call(`/batches/${ID}/save`, saveBody(next, current))).status).toBe(200);
    const added = stored(memberPath(456)) as BatchMember;
    expect(added.proposed.text.en).toEqual(current.text.en);
    expect(changedFields(added.base, added.proposed)).toEqual(['text.de']);
  });
  it('refuses batch write bodies over 300 KiB (as /publish)', async () => {
    const proposal = (stored(memberPath()) as BatchMember).proposed;
    const base = withText(proposal, 'fr', 'x'.repeat(180_000));
    const next = withText(base, 'de', 'Neu');
    expect((await call(`/batches/${ID}/save`, saveBody(next, base))).status).toBe(413);
  });
});
