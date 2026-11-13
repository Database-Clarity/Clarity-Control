import { describe, expect, it } from 'vitest';
import {
  publishIntentDigest,
  publishPayloadSchema,
  type PublishIntent,
} from '../publishRequest.js';
import type { Tooltip } from '../schemas.js';
import {
  activationConflictSchema,
  approvedDigest,
  batchIntentDigest,
  batchMemberSchema,
  batchPublishPayloadSchema,
  batchSchema,
  checkNotBefore,
  dueSchema,
  initialRevisions,
  isContentChange,
  nextRevisions,
  notBeforeSchema,
  nowMinute,
  scheduleIndexSchema,
  zonedToUtc,
  zoneOffsetMinutes,
  type Batch,
  type BatchPublishIntent,
  type DigestMember,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const entry = (text: string, updatedAt = T0, extra: object = {}) => ({
  text,
  updatedAt,
  updatedBy: 'a',
  ...extra,
});
const OP = '01KA0000000000000000000000';
const OP2 = '01KA0000000000000000000001';
const BATCH = '01KA00000000000000000000ZZ';
const user = { id: 1, login: 'alice' };

const base: Tooltip = {
  hash: 7,
  text: { en: entry('Old'), de: entry('Alt', T0, { sourceUpdatedAt: T0 }) },
  associated: [1],
};
const proposed: Tooltip = { ...base, text: { ...base.text, en: entry('New', T1) } };
const other: Tooltip = { hash: 9, text: { en: entry('Nine') }, associated: [] };
const members: DigestMember[] = [
  { hash: 9, base: other, proposed: other },
  { hash: 7, base, proposed },
];

describe('approvedDigest (I5)', () => {
  it('is a pinned golden over sorted members', async () => {
    const digest = await approvedDigest(members);
    expect(digest).toBe('9de584234ba8b372f5c4edb80984777146dbcda32dc6b5c346afcb29469a107c');
    expect(await approvedDigest([...members].reverse())).toBe(digest);
  });
  it('ignores a stamp-only English proposal, as changedFields does (code F2)', async () => {
    const restamped: Tooltip = {
      ...base,
      text: { ...base.text, en: entry('Old', T1, { updatedBy: 'b' }) },
    };
    const before: DigestMember[] = [{ hash: 7, base, proposed: base }];
    const after: DigestMember[] = [{ hash: 7, base, proposed: restamped }];
    expect(await approvedDigest(after)).toBe(await approvedDigest(before));
    expect(isContentChange(before, after)).toBe(false);
  });
  it('is stable under translation saves (text and stamps)', async () => {
    const digest = await approvedDigest(members);
    const translated: Tooltip = {
      ...proposed,
      text: {
        ...proposed.text,
        de: entry('Neu', T1, { sourceUpdatedAt: T1 }),
        fr: entry('Neuf', T1, { sourceUpdatedAt: T1 }),
      },
    };
    const after = [members[0], { ...members[1], proposed: translated }];
    expect(await approvedDigest(after)).toBe(digest);
    expect(isContentChange(members, after)).toBe(false);
  });
  it('changes with membership, rebase, and every non-translation field', async () => {
    const digest = await approvedDigest(members);
    const variants: DigestMember[][] = [
      [members[1]],
      [...members, { hash: 11, base: null, proposed: { hash: 11, text: {}, associated: [] } }],
      [
        members[0],
        { ...members[1], base: { ...base, text: { ...base.text, de: entry('Rebased', T1) } } },
      ],
      ...(
        [
          { text: { ...proposed.text, en: entry('Newer', T1) } },
          { associated: [1, 2] },
          { custom: { name: 'n', categoryId: 'c' } },
          { legacy: { uploadedBy: 'x' } },
          { bungieSnapshot: { description: 'd', snapshotAt: T1 } },
          {
            archive: {
              removedAt: T1,
              lastSeen: { name: 'n', categoryId: 'c', manifestVersion: '1' },
            },
          },
        ] as Partial<Tooltip>[]
      ).map((change) => [members[0], { ...members[1], proposed: { ...proposed, ...change } }]),
    ];
    for (const variant of variants) {
      expect(await approvedDigest(variant)).not.toBe(digest);
      expect(isContentChange(members, variant)).toBe(true);
    }
  });
  it('refuses duplicate or mismatched members', () => {
    expect(() => approvedDigest([members[1], members[1]])).toThrow(/Duplicate/);
    expect(() => approvedDigest([{ hash: 8, base, proposed }])).toThrow(/another hash/);
  });
});

describe('revisions', () => {
  it('revision moves on every write, contentRevision only on content changes', () => {
    expect(initialRevisions).toEqual({ revision: 1, contentRevision: 0 });
    expect(nextRevisions({ revision: 4, contentRevision: 2 }, false)).toEqual({
      revision: 5,
      contentRevision: 2,
    });
    expect(nextRevisions({ revision: 4, contentRevision: 2 }, true)).toEqual({
      revision: 5,
      contentRevision: 3,
    });
  });
});

describe('request payloads', () => {
  it('push payload digest stays byte-identical (golden)', async () => {
    const intent: PublishIntent = {
      kind: 'push',
      opId: OP,
      repo: 'owner/editor-data',
      dataBranch: 'main',
      liveBranch: 'live',
      requester: { id: 1, login: 'alice' },
      hashes: [9, 7],
      expected: { '7': 'a'.repeat(64), '9': 'b'.repeat(64) },
    };
    const digest = await publishIntentDigest(intent);
    expect(digest).toBe('caa65981a6067b528f233d42a9397c212c24935442305ac808c12f0d38606ae8');
    expect(
      publishPayloadSchema.safeParse({ ...intent, createdAt: T0, intentDigest: digest }).success,
    ).toBe(true);
  });
  it('batch intent digest binds every intent field but the login', async () => {
    const intent: BatchPublishIntent = {
      kind: 'batch',
      opId: OP,
      repo: 'owner/editor-data',
      dataBranch: 'main',
      liveBranch: 'live',
      requester: user,
      batchId: BATCH,
      contentRevision: 3,
      notBefore: '2026-12-03T16:00:00.000Z',
      hashes: [7, 9],
      approvedDigest: 'c'.repeat(64),
    };
    const digest = await batchIntentDigest(intent);
    expect(digest).toBe('2558049b755d16c7f6426a1545c95629433526ed26383b0b4b91dac283fcef96');
    expect(await batchIntentDigest({ ...intent, requester: { id: 1, login: 'renamed' } })).toBe(
      digest,
    );
    for (const change of [
      { opId: OP2 },
      { repo: 'x/y' },
      { dataBranch: 'd' },
      { liveBranch: 'l' },
      { requester: { id: 2, login: 'alice' } },
      { batchId: OP2 },
      { contentRevision: 4 },
      { notBefore: '2026-12-03T16:01:00.000Z' },
      { hashes: [7] },
      { approvedDigest: 'd'.repeat(64) },
    ])
      expect(await batchIntentDigest({ ...intent, ...change })).not.toBe(digest);
    const payload = { ...intent, createdAt: T0, intentDigest: digest };
    expect(batchPublishPayloadSchema.safeParse(payload).success).toBe(true);
    expect(batchPublishPayloadSchema.safeParse({ ...payload, hashes: [9, 7] }).success).toBe(false);
    expect(
      batchPublishPayloadSchema.safeParse({ ...payload, notBefore: '2026-12-03T16:00:30.000Z' })
        .success,
    ).toBe(false);
    expect(batchPublishPayloadSchema.safeParse({ ...payload, expected: {} }).success).toBe(false);
  });
});

const draft: Batch = {
  id: BATCH,
  name: 'December balance',
  createdBy: user,
  createdAt: T0,
  revision: 1,
  contentRevision: 0,
  status: 'draft',
  notBefore: null,
  zone: null,
  opId: null,
  scheduledContentRevision: null,
  claim: null,
  result: null,
  events: [{ at: T0, by: user, action: 'create', revision: 1, contentRevision: 0 }],
};
const scheduled: Batch = {
  ...draft,
  revision: 3,
  contentRevision: 1,
  status: 'scheduled',
  notBefore: '2026-12-03T16:00:00.000Z',
  zone: 'Europe/Berlin',
  opId: OP,
  scheduledContentRevision: 1,
};
const claim = { opId: OP, claimedAt: T1 };

describe('schemas', () => {
  it('batch status invariants', () => {
    const ok = (value: unknown) => batchSchema.safeParse(value).success;
    expect(ok(draft)).toBe(true);
    expect(ok(scheduled)).toBe(true);
    expect(ok({ ...scheduled, status: 'publishing', claim })).toBe(true);
    expect(
      ok({
        ...scheduled,
        status: 'published',
        claim,
        result: {
          opId: OP,
          status: 'published',
          landedAt: T1,
          landedAtSource: 'cas',
          recordedAt: T1,
          exportNow: T1,
          liveCommit: 'f'.repeat(40),
        },
      }),
    ).toBe(true);
    // Failure returns to draft with the failed result kept.
    expect(
      ok({
        ...draft,
        result: {
          opId: OP,
          status: 'stale',
          outcomes: [{ hash: 7, status: 'stale', fields: ['text.en'] }],
        },
      }),
    ).toBe(true);
    expect(ok({ ...draft, opId: OP })).toBe(false);
    expect(ok({ ...scheduled, claim })).toBe(false);
    expect(ok({ ...scheduled, opId: null })).toBe(false);
    expect(ok({ ...scheduled, status: 'publishing' })).toBe(false);
    expect(ok({ ...scheduled, status: 'publishing', claim: { ...claim, opId: OP2 } })).toBe(false);
    expect(ok({ ...scheduled, status: 'published', claim })).toBe(false);
    expect(ok({ ...scheduled, scheduledContentRevision: 2 })).toBe(false);
    expect(ok({ ...draft, contentRevision: 2 })).toBe(false);
    expect(ok({ ...draft, name: ' padded' })).toBe(false);
    expect(ok({ ...draft, name: 'x'.repeat(81) })).toBe(false);
    expect(ok({ ...draft, extra: 1 })).toBe(false);
    expect(
      ok({ ...draft, result: { opId: OP, status: 'stale', landedAt: T1, landedAtSource: 'cas' } }),
    ).toBe(false);
    expect(ok({ ...draft, result: { opId: OP, status: 'published', landedAt: T1 } })).toBe(false);
    expect(ok({ ...draft, events: Array(201).fill(draft.events[0]) })).toBe(false);
    // Impossible states (code F3, sec MUST 3).
    const landed = {
      opId: OP,
      status: 'published',
      landedAt: T1,
      landedAtSource: 'cas',
      recordedAt: T1,
      exportNow: T1,
      liveCommit: 'f'.repeat(40),
    };
    expect(ok({ ...scheduled, contentRevision: 2 })).toBe(false);
    expect(ok({ ...scheduled, status: 'publishing', claim, contentRevision: 2 })).toBe(false);
    expect(ok({ ...draft, result: landed })).toBe(false);
    expect(ok({ ...draft, result: { opId: OP, status: 'unchanged', recordedAt: T1 } })).toBe(false);
    expect(ok({ ...draft, status: 'cancelled', result: landed })).toBe(false);
    expect(ok({ ...scheduled, opId: OP2, result: landed })).toBe(false);
    const published = { ...scheduled, status: 'published', claim };
    for (const key of ['landedAt', 'recordedAt', 'exportNow', 'liveCommit']) {
      const partial: Record<string, unknown> = { ...landed, landedAtSource: 'cas' };
      delete partial[key];
      if (key === 'landedAt') delete partial.landedAtSource;
      expect(ok({ ...published, result: partial })).toBe(false);
    }
    expect(ok({ ...published, result: { opId: OP, status: 'unchanged', recordedAt: T1 } })).toBe(
      true,
    );
    expect(ok({ ...published, result: { opId: OP, status: 'unchanged' } })).toBe(false);
  });
  it('notBefore is a canonical whole UTC minute', () => {
    expect(notBeforeSchema.safeParse('2026-12-03T16:00:00.000Z').success).toBe(true);
    for (const value of [
      '2026-12-03T16:00:00Z',
      '2026-12-03T16:00:01.000Z',
      '2026-02-30T16:00:00.000Z',
      '2026-12-03T16:00:00.000+01:00',
    ])
      expect(notBeforeSchema.safeParse(value).success).toBe(false);
  });
  it('members, due, index, and conflict files', () => {
    const member = {
      hash: 7,
      base,
      baseCommit: 'a'.repeat(40),
      proposed,
      updatedAt: T1,
      updatedBy: 'alice',
    };
    expect(batchMemberSchema.safeParse(member).success).toBe(true);
    expect(batchMemberSchema.safeParse({ ...member, base: null }).success).toBe(true);
    expect(batchMemberSchema.safeParse({ ...member, hash: 8 }).success).toBe(false);
    const due = { batchId: BATCH, opId: OP, notBefore: '2026-12-03T16:00:00.000Z', claimed: false };
    expect(dueSchema.safeParse({ entries: [due] }).success).toBe(true);
    expect(dueSchema.safeParse({ entries: [due, { ...due, opId: OP2 }] }).success).toBe(false);
    const row = {
      id: BATCH,
      name: 'n',
      status: 'draft',
      notBefore: null,
      opId: null,
      revision: 1,
      hashes: [7, 9],
      updatedAt: T0,
    };
    expect(scheduleIndexSchema.safeParse({ batches: [row] }).success).toBe(true);
    expect(scheduleIndexSchema.safeParse({ batches: [{ ...row, hashes: [9, 7] }] }).success).toBe(
      false,
    );
    const ids = Array.from(
      { length: 51 },
      (_, i) => `01KA00000000000000000000${String(i).padStart(2, '0')}`,
    );
    expect(
      scheduleIndexSchema.safeParse({ batches: ids.map((id) => ({ ...row, id })) }).success,
    ).toBe(false);
    expect(
      scheduleIndexSchema.safeParse({
        batches: ids.map((id) => ({ ...row, id, status: 'published' })),
      }).success,
    ).toBe(true);
    const conflict = {
      hash: 7,
      batchId: BATCH,
      opId: OP,
      fields: ['text.en'],
      changed: ['text.en'],
      base,
      proposed,
      currentAtRecord: { ...base, text: { ...base.text, en: entry('Other', T1) } },
    };
    expect(activationConflictSchema.safeParse(conflict).success).toBe(true);
    expect(activationConflictSchema.safeParse({ ...conflict, changed: [] }).success).toBe(false);
    expect(activationConflictSchema.safeParse({ ...conflict, fields: ['text.de'] }).success).toBe(
      false,
    );
    expect(
      activationConflictSchema.safeParse({
        ...conflict,
        base: null,
        fields: ['$exists'],
        changed: ['text.en', 'text.de', 'associated'],
      }).success,
    ).toBe(true);
    // Existence must match the frozen snapshots (code F4, sec MUST 3).
    const parse = (value: object) =>
      activationConflictSchema.safeParse({ ...conflict, ...value }).success;
    expect(parse({ fields: ['$exists'] })).toBe(false);
    expect(parse({ currentAtRecord: null })).toBe(false);
    expect(parse({ currentAtRecord: null, fields: ['$exists'] })).toBe(true);
    expect(parse({ fields: ['text.en', 'text.en'] })).toBe(false);
    expect(parse({ currentAtRecord: base })).toBe(false);
    // A mismatched hash fails without throwing (code F5).
    expect(() => parse({ base: { ...base, hash: 8 } })).not.toThrow();
    expect(parse({ base: { ...base, hash: 8 } })).toBe(false);
  });
});

describe('zone to UTC', () => {
  it('converts an ordinary minute', () => {
    expect(zonedToUtc('2026-12-03', '17:00', 'Europe/Berlin')).toEqual({
      status: 'exact',
      notBefore: '2026-12-03T16:00:00.000Z',
      offsetMinutes: 60,
    });
    expect(zonedToUtc('2026-07-01', '09:30', 'America/New_York')).toMatchObject({
      notBefore: '2026-07-01T13:30:00.000Z',
      offsetMinutes: -240,
    });
    expect(zonedToUtc('2026-07-01', '09:30', 'Asia/Kolkata')).toMatchObject({
      notBefore: '2026-07-01T04:00:00.000Z',
      offsetMinutes: 330,
    });
    expect(zonedToUtc('2026-07-01', '00:00', 'UTC')).toMatchObject({
      notBefore: '2026-07-01T00:00:00.000Z',
      offsetMinutes: 0,
    });
  });
  it('refuses a DST gap', () => {
    expect(zonedToUtc('2026-03-29', '02:30', 'Europe/Berlin')).toEqual({ status: 'gap' });
    expect(zonedToUtc('2026-03-08', '02:00', 'America/New_York')).toEqual({ status: 'gap' });
    // Lord Howe moves by 30 minutes.
    expect(zonedToUtc('2026-10-04', '02:15', 'Australia/Lord_Howe')).toEqual({ status: 'gap' });
    expect(zonedToUtc('2026-03-29', '03:00', 'Europe/Berlin')).toMatchObject({
      status: 'exact',
      notBefore: '2026-03-29T01:00:00.000Z',
    });
  });
  it('offers both offsets for a repeated hour, earlier first', () => {
    expect(zonedToUtc('2026-10-25', '02:30', 'Europe/Berlin')).toEqual({
      status: 'overlap',
      options: [
        { notBefore: '2026-10-25T00:30:00.000Z', offsetMinutes: 120 },
        { notBefore: '2026-10-25T01:30:00.000Z', offsetMinutes: 60 },
      ],
    });
    expect(zonedToUtc('2026-11-01', '01:59', 'America/New_York')).toMatchObject({
      status: 'overlap',
      options: [
        { notBefore: '2026-11-01T05:59:00.000Z' },
        { notBefore: '2026-11-01T06:59:00.000Z' },
      ],
    });
  });
  it('rejects malformed input and unknown zones', () => {
    expect(() => zonedToUtc('2026-02-30', '10:00', 'UTC')).toThrow();
    expect(() => zonedToUtc('2026-02-01', '24:00', 'UTC')).toThrow();
    expect(() => zonedToUtc('2026-02-01', '9:00', 'UTC')).toThrow();
    expect(() => zonedToUtc('2026-02-01', '09:00', 'Mars/Olympus')).toThrow(/Unknown time zone/);
  });
  it('offsets and admission bounds', () => {
    expect(zoneOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(60);
    const now = Date.parse('2026-12-03T15:56:30.000Z');
    expect(nowMinute(now)).toBe('2026-12-03T15:56:00.000Z');
    expect(checkNotBefore('2026-12-03T15:59:00.000Z', now)).toMatchObject({ ok: false });
    expect(checkNotBefore('2026-12-03T16:00:00.000Z', now)).toEqual({ ok: true });
    expect(checkNotBefore('2027-12-05T16:00:00.000Z', now)).toMatchObject({ ok: false });
    expect(checkNotBefore('2026-12-03T16:00:30.000Z', now)).toMatchObject({ ok: false });
  });
});
